import { Hono } from "hono";
import { authRoutes } from "@worker/routes/auth";
import { productRoutes } from "@worker/routes/products";
import { transactionRoutes } from "@worker/routes/transactions";
import { accountingRoutes } from "@worker/routes/accounting";
import { webhookRoutes } from "@worker/routes/webhooks";
import { isApprovedLiveStripeKey } from "@worker/services/stripe-client";
import { expireAbandonedReaderDisplays } from "@worker/services/terminal-payment";
import { testAccessConfigured } from "@worker/services/test-access";
import type { WorkerEnvironment } from "@worker/types";

export function createApp() {
  const app = new Hono<WorkerEnvironment>();
  app.get("/api/health", (c) => c.json({
    ok: true,
    runtime: "cloudflare-workers",
    databaseConfigured: Boolean(c.env.HYPERDRIVE || c.env.DATABASE_URL),
    authenticationConfigured: testAccessConfigured(c.env),
    terminalConfigured: Boolean(c.env.STRIPE_LIVE_MODE_ONLY === "true" && isApprovedLiveStripeKey(c.env.STRIPE_SECRET_KEY) && c.env.STRIPE_TERMINAL_READER_ID && c.env.STRIPE_TERMINAL_LOCATION_ID && c.env.STRIPE_TERMINAL_WEBHOOK_SECRET),
    stripeMode: "live-only",
  }));
  app.route("/api", authRoutes);
  app.route("/api/products", productRoutes);
  app.route("/api/transactions", transactionRoutes);
  app.route("/api/accounting", accountingRoutes);
  app.route("/api/webhooks", webhookRoutes);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("Worker request failed", error);
    return c.json({ error: "Request could not be completed" }, 500);
  });
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: WorkerEnvironment["Bindings"], ctx: ExecutionContext) {
    ctx.waitUntil(expireAbandonedReaderDisplays({ env }));
  },
};
