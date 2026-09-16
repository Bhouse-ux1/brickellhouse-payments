import { Hono } from "hono";
import { createDatabase } from "@/db/client";
import { requireAdmin } from "@worker/middleware/require-admin";
import { readTerminalDiagnostic } from "@worker/services/terminal-diagnostic";
import type { WorkerEnvironment } from "@worker/types";

export function createTerminalDiagnosticRoutes(readDiagnostic = readTerminalDiagnostic, createDb = createDatabase) {
  const routes = new Hono<WorkerEnvironment>();
  routes.use("/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  routes.use("/*", requireAdmin);
  routes.get("/terminal-incident", async (c) => {
    try {
      const db = createDb(c.env);
      if (!db) return c.json({ error: "Diagnostic storage unavailable" }, 503);
      return c.json(await readDiagnostic(db, c.env));
    } catch {
      // Never serialize or log provider errors, request headers, or Stripe objects.
      return c.json({ error: "Read-only diagnostic unavailable", decision: "RECONCILIATION_REQUIRED" }, 503);
    }
  });
  return routes;
}
