import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "@/db/client";
import { requireEmployee } from "@worker/middleware/require-employee";
import type { WorkerEnvironment } from "@worker/types";

export const accountingRoutes = new Hono<WorkerEnvironment>();
accountingRoutes.use("/*", requireEmployee);
accountingRoutes.get("/summary", async (c) => {
  const employee = c.get("employee");
  if (!(["ADMIN", "MANAGER", "ACCOUNTING"] as const).includes(employee.role as "ADMIN" | "MANAGER" | "ACCOUNTING")) {
    return c.json({ error: "Accounting access required" }, 403);
  }
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Accounting data is not configured" }, 503);
  const rows = await db.execute(sql<{ gl_code: string; amount_cents: string; item_count: string }>`
    select ti.gl_code_snapshot as gl_code,
           coalesce(sum(ti.line_total_cents), 0)::text as amount_cents,
           count(*)::text as item_count
      from transaction_items ti
      join transactions t on t.id = ti.transaction_id
     where t.payment_status = 'PAID'
     group by ti.gl_code_snapshot
     order by ti.gl_code_snapshot
  `);
  return c.json({ groups: rows });
});
