import { Hono } from "hono";
import { authRoutes, handleProductionAuthRequest } from "@worker/routes/auth";
import { productRoutes } from "@worker/routes/products";
import { transactionRoutes } from "@worker/routes/transactions";
import { accountingRoutes } from "@worker/routes/accounting";
import { adminRoutes } from "@worker/routes/admin";
import { webhookRoutes } from "@worker/routes/webhooks";
import { isApprovedLiveStripeKey } from "@worker/services/stripe-client";
import { runScheduledDatabaseKeepalive } from "@worker/services/database-keepalive";
import { productionAuthConfigured } from "@worker/services/production-auth";
import type { WorkerEnvironment } from "@worker/types";

export function createApp() {
  const app = new Hono<WorkerEnvironment>();
  app.get("/api/health", (c) => c.json({
    ok: true,
    runtime: "cloudflare-workers",
    databaseConfigured: Boolean(c.env.HYPERDRIVE || c.env.DATABASE_URL),
    authenticationConfigured: productionAuthConfigured(c.env),
    terminalConfigured: Boolean(c.env.STRIPE_LIVE_MODE_ONLY === "true" && isApprovedLiveStripeKey(c.env.STRIPE_SECRET_KEY) && c.env.STRIPE_TERMINAL_READER_ID && c.env.STRIPE_TERMINAL_LOCATION_ID && c.env.STRIPE_TERMINAL_WEBHOOK_SECRET),
    stripeMode: "live-only",
  }));
  app.all("/api/auth/*", (c) => handleProductionAuthRequest(c.req.raw, c.env));
  app.route("/api", authRoutes);
  app.route("/api/products", productRoutes);
  app.route("/api/transactions", transactionRoutes);
  app.route("/api/accounting", accountingRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/webhooks", webhookRoutes);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("Worker request failed", error);
    return c.json({ error: "Request could not be completed" }, 500);
  });
  return app;
}

const app = createApp();

export function createScheduledHandler(
  keepalive: (env: WorkerEnvironment["Bindings"]) => Promise<void> = runScheduledDatabaseKeepalive,
) {
  return function scheduled(
    _controller: ScheduledController,
    env: WorkerEnvironment["Bindings"],
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(keepalive(env));
  };
}

export default {
  fetch: app.fetch,
  scheduled: createScheduledHandler(),
};
