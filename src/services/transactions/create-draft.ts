import { inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { products, transactionItems, transactions } from "@/db/schema";
import type { TrustedProduct } from "@/domain/products/catalog";
import { reconstructTrustedTransaction } from "@/domain/transactions/reconstruct";
import { checkoutRequestSchema } from "@/domain/transactions/validation";

export function formatTransactionNumber(sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid transaction sequence.");
  return `POS-${String(sequence).padStart(6, "0")}`;
}

export async function createDraftTransaction(db: Database, untrustedInput: unknown, employeeId: string) {
  const parsed = checkoutRequestSchema.parse(untrustedInput);
  const ids = [...new Set(parsed.items.map((item) => item.productId))];
  return db.transaction(async (tx) => {
    const trustedRows = ids.length ? await tx.select().from(products).where(inArray(products.id, ids)) : [];
    const trusted = reconstructTrustedTransaction(parsed, trustedRows as TrustedProduct[]);
    const sequenceRows = await tx.execute(sql<{ value: string }>`select nextval('pos_transaction_number_seq')::text as value`);
    const sequence = Number(sequenceRows[0].value);
    const number = formatTransactionNumber(sequence);
    const [created] = await tx.insert(transactions).values({
      numberSequence: sequence, number, unitNumber: trusted.unitNumber,
      customerEmail: trusted.customerEmail, employeeId,
      subtotalCents: trusted.subtotalCents, processingFeeCents: trusted.processingFeeCents,
      totalCents: trusted.totalCents, paymentStatus: "DRAFT",
    }).returning({ id: transactions.id, number: transactions.number });
    await tx.insert(transactionItems).values(trusted.lines.map((line) => ({
      transactionId: created.id, productId: line.productId,
      productNameSnapshot: line.productNameSnapshot, unitPriceCentsSnapshot: line.unitPriceCentsSnapshot,
      quantity: line.quantity, glCodeSnapshot: line.glCodeSnapshot, lineTotalCents: line.lineTotalCents,
    })));
    return { ...created, ...trusted };
  });
}
