import { Hono } from "hono";
import { createDatabase } from "@/db/client";
import { requireAdmin } from "@worker/middleware/require-admin";
import { readTerminalDiagnostic } from "@worker/services/terminal-diagnostic";
import { recoverTerminalIncident } from "@worker/services/terminal-incident-recovery";
import type { WorkerEnvironment } from "@worker/types";

export function createTerminalDiagnosticRoutes(readDiagnostic = readTerminalDiagnostic, createDb = createDatabase, recover = recoverTerminalIncident) {
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
  routes.get("/terminal-incident/recover", (c) => {
    c.header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recover POS-000026</title><h1>Recover POS-000026</h1><p>This action rechecks the existing payment and cancels it only if it is still unpaid, has no card or charge, and the terminal is idle. It sends no terminal commands.</p><form method="post"><button type="submit">Recheck and cancel POS-000026</button></form></html>');
  });
  routes.post("/terminal-incident/recover", async c => {
    if (!c.env.BETTER_AUTH_URL || c.req.header("origin") !== new URL(c.env.BETTER_AUTH_URL).origin) {
      return c.json({ error: "Same-origin Admin request required" }, 403);
    }
    try {
      const db = createDb(c.env);
      if (!db) return c.json({ error: "Recovery storage unavailable" }, 503);
      const result = await recover(db, c.env);
      return c.json(result, result.outcome === "REFUSED" ? 409 : 200);
    } catch {
      return c.json({ error: "Recovery could not be verified", decision: "RECONCILIATION_REQUIRED" }, 503);
    }
  });
  return routes;
}
