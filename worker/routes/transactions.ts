import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError } from "zod";
import { createDatabase } from "@/db/client";
import { emailDeliveries, paymentAttempts, transactionItems, transactions } from "@/db/schema";
import { employeePaymentStatus } from "@/domain/payments/status-display";
import { createDraftTransaction } from "@/services/transactions/create-draft";
import { requireEmployee } from "@worker/middleware/require-employee";
import {
  cancelTerminalPayment, clearTerminalDisplay, startTerminalPayment, TerminalFlowError,
} from "@worker/services/terminal-payment";
import type { WorkerEnvironment } from "@worker/types";
import { deliverPaidTransactionReceipt, queueReceiptResend } from "@worker/services/receipt-delivery";
import { emailDeliveryConfigured } from "@worker/services/resend-email";

export const transactionRoutes = new Hono<WorkerEnvironment>();
transactionRoutes.use("/*", requireEmployee);

transactionRoutes.get("/", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Transaction history is not configured" }, 503);
  const rows = await db.select({
    id: transactions.id, number: transactions.number, unitNumber: transactions.unitNumber,
    customerEmail: transactions.customerEmail, subtotalCents: transactions.subtotalCents,
    processingFeeCents: transactions.processingFeeCents, totalCents: transactions.totalCents,
    paymentStatus: transactions.paymentStatus, createdAt: transactions.createdAt,
    lastErrorCode: sql<string | null>`(
      select pa.last_error_code from payment_attempts pa
      where pa.transaction_id = ${transactions.id}
      order by pa.attempt_number desc limit 1
    )`,
    receiptStatus: sql<string | null>`(
      select ed.status from email_deliveries ed
      where ed.transaction_id = ${transactions.id} limit 1
    )`,
  }).from(transactions).orderBy(desc(transactions.createdAt)).limit(100);
  return c.json({ transactions: rows });
});

transactionRoutes.get("/export.csv", (c) => {
  return c.json({ error: "CSV export is not enabled" }, 501);
});

transactionRoutes.get("/:id", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Transaction details are not configured" }, 503);
  const [transaction] = await db.select({
    id: transactions.id,
    number: transactions.number,
    unitNumber: transactions.unitNumber,
    customerEmail: transactions.customerEmail,
    subtotalCents: transactions.subtotalCents,
    processingFeeCents: transactions.processingFeeCents,
    totalCents: transactions.totalCents,
    paymentStatus: transactions.paymentStatus,
    paymentMethod: transactions.paymentMethod,
    paidAt: transactions.paidAt,
    cardBrand: transactions.cardBrand,
    cardLastFour: transactions.cardLastFour,
    createdAt: transactions.createdAt,
    updatedAt: transactions.updatedAt,
  }).from(transactions).where(eq(transactions.id, c.req.param("id"))).limit(1);
  if (!transaction) return c.json({ error: "Transaction not found" }, 404);
  const items = await db.select().from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
  const [paymentAttempt] = await db.select({
    status: paymentAttempts.status,
    lastErrorCode: paymentAttempts.lastErrorCode,
  }).from(paymentAttempts).where(eq(paymentAttempts.transactionId, transaction.id))
    .orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
  const [receipt] = await db.select({
    status: emailDeliveries.status,
    sentAt: emailDeliveries.sentAt,
    attemptCount: emailDeliveries.attemptCount,
  }).from(emailDeliveries).where(eq(emailDeliveries.transactionId, transaction.id)).limit(1);
  return c.json({
    transaction, items, receipt: receipt ?? null,
    payment: {
      status: transaction.paymentStatus,
      displayStatus: employeePaymentStatus[transaction.paymentStatus],
      readerDisplayPending: transaction.paymentStatus === "SENDING_TO_TERMINAL" &&
        paymentAttempt?.status === "READER_RESERVED" && !paymentAttempt.lastErrorCode,
      recoverable: Boolean(paymentAttempt && !["SUCCEEDED", "CANCELED", "EXPIRED"].includes(paymentAttempt.status)),
    },
  });
});

transactionRoutes.post("/:id/receipt/resend", async (c) => {
  if (!emailDeliveryConfigured(c.env)) return c.json({ error: "Receipt email is not configured" }, 503);
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Receipt delivery storage is not configured" }, 503);
  const queued = await queueReceiptResend({ db, transactionId: c.req.param("id") });
  if (queued.status === "NOT_PAID") return c.json({ error: "Only completed payments can have receipts" }, 409);
  if (queued.status === "NOT_QUEUED") return c.json({ error: "Receipt delivery was not found" }, 404);
  if (queued.status === "IN_PROGRESS") return c.json({ error: "Receipt delivery is already in progress" }, 409);
  const result = await deliverPaidTransactionReceipt({ db, env: c.env, transactionId: c.req.param("id") });
  return c.json({ status: result.status });
});

transactionRoutes.post("/", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Transaction storage is not configured" }, 503);
  try {
    const created = await createDraftTransaction(db, await c.req.json(), c.get("employee").id);
    return c.json({ transaction: created }, 201);
  } catch (error) {
    if (error instanceof ZodError) return c.json({ error: "Invalid transaction", issues: error.issues }, 400);
    throw error;
  }
});

transactionRoutes.post("/:id/payment-attempts", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Terminal payment storage is not configured" }, 503);
  try {
    return c.json(await startTerminalPayment({ db, env: c.env, transactionId: c.req.param("id") }));
  } catch (error) {
    if (error instanceof TerminalFlowError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

transactionRoutes.post("/:id/payment-attempts/cancel", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Terminal payment storage is not configured" }, 503);
  try {
    return c.json(await cancelTerminalPayment({ db, env: c.env, transactionId: c.req.param("id") }));
  } catch (error) {
    if (error instanceof TerminalFlowError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

transactionRoutes.post("/:id/payment-attempts/clear-terminal", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Terminal payment storage is not configured" }, 503);
  try {
    return c.json(await clearTerminalDisplay({ db, env: c.env, transactionId: c.req.param("id") }));
  } catch (error) {
    if (error instanceof TerminalFlowError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});
