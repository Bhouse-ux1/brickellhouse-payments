import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError } from "zod";
import { createDatabase } from "@/db/client";
import { transactionItems, transactions } from "@/db/schema";
import { createDraftTransaction } from "@/services/transactions/create-draft";
import { requireEmployee } from "@worker/middleware/require-employee";
import type { WorkerEnvironment } from "@worker/types";

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
  }).from(transactions).orderBy(desc(transactions.createdAt)).limit(100);
  return c.json({ transactions: rows });
});

transactionRoutes.get("/:id", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Transaction details are not configured" }, 503);
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, c.req.param("id"))).limit(1);
  if (!transaction) return c.json({ error: "Transaction not found" }, 404);
  const items = await db.select().from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
  return c.json({ transaction, items });
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
  void c.req.param("id");
  return c.json({ error: "Terminal payments are not enabled" }, 501);
});

transactionRoutes.get("/export.csv", (c) => {
  return c.json({ error: "CSV export is not enabled" }, 501);
});
