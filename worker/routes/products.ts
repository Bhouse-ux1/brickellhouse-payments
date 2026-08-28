import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "@/db/client";
import { products } from "@/db/schema";
import { requireEmployee } from "@worker/middleware/require-employee";
import type { WorkerEnvironment } from "@worker/types";

export const productRoutes = new Hono<WorkerEnvironment>();
productRoutes.use("/*", requireEmployee);
productRoutes.get("/", async (c) => {
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Product catalog is not configured" }, 503);

  const rows = await db.select({
    id: products.id,
    displayName: products.displayName,
    priceCents: products.priceCents,
    active: products.active,
    terminalEnabled: products.terminalEnabled,
    quantityAllowed: products.quantityAllowed,
    category: products.category,
  }).from(products)
    .where(and(eq(products.active, true), eq(products.terminalEnabled, true)))
    .orderBy(asc(products.category), asc(products.displayName));

  return c.json({ products: rows });
});
