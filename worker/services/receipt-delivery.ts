import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { createDatabase } from "@/db/client";
import { emailDeliveries, transactionItems, transactions } from "@/db/schema";
import { renderReceiptEmail } from "@/services/email/receipt-email";
import { emailDeliveryConfigured, sendResendEmail } from "@worker/services/resend-email";
import type { WorkerBindings } from "@worker/types";

export function receiptIdempotencyKey(transactionId: string, deliveryVersion: number) {
  if (!transactionId || !Number.isSafeInteger(deliveryVersion) || deliveryVersion < 1) {
    throw new Error("Receipt delivery identity is invalid.");
  }
  return `receipt/${transactionId}/v${deliveryVersion}`;
}

export async function deliverPaidTransactionReceipt(input: {
  db: Database;
  env: WorkerBindings;
  transactionId: string;
  fetcher?: typeof fetch;
}) {
  if (!emailDeliveryConfigured(input.env)) return { status: "NOT_CONFIGURED" as const };
  const [transaction] = await input.db.select().from(transactions)
    .where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction || transaction.paymentStatus !== "PAID" || !transaction.paidAt) return { status: "NOT_PAID" as const };
  const [delivery] = await input.db.select().from(emailDeliveries)
    .where(eq(emailDeliveries.transactionId, transaction.id)).limit(1);
  if (!delivery) return { status: "NOT_QUEUED" as const };
  if (delivery.status === "SENT") return { status: "ALREADY_SENT" as const };
  if (delivery.status === "SENDING") return { status: "IN_PROGRESS" as const };
  if (!delivery.recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(delivery.recipientEmail)) {
    await input.db.update(emailDeliveries).set({ status: "FAILED", lastError: "Receipt recipient is missing or invalid.", updatedAt: new Date() })
      .where(eq(emailDeliveries.id, delivery.id));
    return { status: "FAILED" as const };
  }
  const [claimed] = await input.db.update(emailDeliveries).set({
    status: "SENDING",
    attemptCount: sql`${emailDeliveries.attemptCount} + 1`,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(eq(emailDeliveries.id, delivery.id), eq(emailDeliveries.status, "PENDING")))
    .returning({ id: emailDeliveries.id });
  if (!claimed) return { status: "IN_PROGRESS" as const };
  try {
    const items = await input.db.select({
      name: transactionItems.productNameSnapshot,
      quantity: transactionItems.quantity,
      unitAmountCents: transactionItems.unitPriceCentsSnapshot,
      lineTotalCents: transactionItems.lineTotalCents,
    }).from(transactionItems).where(eq(transactionItems.transactionId, transaction.id)).orderBy(asc(transactionItems.createdAt));
    const rendered = renderReceiptEmail({
      transactionNumber: transaction.number,
      paidAt: transaction.paidAt,
      items,
      subtotalCents: transaction.subtotalCents,
      processingFeeCents: transaction.processingFeeCents,
      totalCents: transaction.totalCents,
      cardBrand: transaction.cardBrand,
      cardLastFour: transaction.cardLastFour,
    });
    const providerMessageId = await sendResendEmail({
      env: input.env,
      to: delivery.recipientEmail,
      ...rendered,
      idempotencyKey: receiptIdempotencyKey(transaction.id, delivery.deliveryVersion),
      fetcher: input.fetcher,
    });
    await input.db.update(emailDeliveries).set({
      status: "SENT", providerMessageId, sentAt: new Date(), lastError: null, updatedAt: new Date(),
    }).where(eq(emailDeliveries.id, delivery.id));
    return { status: "SENT" as const };
  } catch (error) {
    console.error("Verified receipt delivery failed", {
      transactionNumber: transaction.number,
      message: error instanceof Error ? error.message : "Unknown receipt delivery failure",
    });
    await input.db.update(emailDeliveries).set({
      status: "FAILED",
      lastError: error instanceof Error ? error.message.slice(0, 500) : "Receipt delivery failed.",
      updatedAt: new Date(),
    }).where(eq(emailDeliveries.id, delivery.id));
    return { status: "FAILED" as const };
  }
}

export async function deliverPendingReceipts(env: WorkerBindings) {
  const db = createDatabase(env);
  if (!db || !emailDeliveryConfigured(env)) return { processed: 0 };
  const pending = await db.select({ transactionId: emailDeliveries.transactionId }).from(emailDeliveries)
    .where(eq(emailDeliveries.status, "PENDING")).orderBy(asc(emailDeliveries.createdAt)).limit(10);
  let processed = 0;
  for (const delivery of pending) {
    const result = await deliverPaidTransactionReceipt({ db, env, transactionId: delivery.transactionId });
    if (result.status === "SENT") processed += 1;
  }
  return { processed };
}

export async function queueReceiptResend(input: { db: Database; transactionId: string }) {
  const [transaction] = await input.db.select({ status: transactions.paymentStatus }).from(transactions)
    .where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction || transaction.status !== "PAID") return { status: "NOT_PAID" as const };
  const [delivery] = await input.db.select().from(emailDeliveries)
    .where(eq(emailDeliveries.transactionId, input.transactionId)).limit(1);
  if (!delivery) return { status: "NOT_QUEUED" as const };
  if (delivery.status === "SENDING") return { status: "IN_PROGRESS" as const };
  await input.db.update(emailDeliveries).set({
    status: "PENDING",
    deliveryVersion: delivery.status === "SENT" ? sql`${emailDeliveries.deliveryVersion} + 1` : delivery.deliveryVersion,
    providerMessageId: delivery.status === "SENT" ? null : delivery.providerMessageId,
    sentAt: delivery.status === "SENT" ? null : delivery.sentAt,
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(emailDeliveries.id, delivery.id));
  return { status: "QUEUED" as const };
}
