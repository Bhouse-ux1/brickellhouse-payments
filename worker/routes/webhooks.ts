import { Hono } from "hono";
import { verifyStripeWebhookSignature } from "@worker/services/stripe-webhook";
import { createDatabase } from "@/db/client";
import { processStripeEvent, StripeWebhookInputError } from "@worker/services/stripe-reconciliation";
import { stripeLiveConfigurationError } from "@worker/services/stripe-client";
import { deliverPaidTransactionNotifications } from "@worker/services/receipt-delivery";
import type { WorkerEnvironment } from "@worker/types";

type WebhookDependencies = {
  verifySignature?: typeof verifyStripeWebhookSignature;
  createDb?: typeof createDatabase;
  processEvent?: typeof processStripeEvent;
};

export function createWebhookRoutes(dependencies: WebhookDependencies = {}) {
  const routes = new Hono<WorkerEnvironment>();
  const verifySignature = dependencies.verifySignature ?? verifyStripeWebhookSignature;
  const createDb = dependencies.createDb ?? createDatabase;
  const processEvent = dependencies.processEvent ?? processStripeEvent;
  routes.post("/stripe", async (c) => {
    const secret = c.env.STRIPE_TERMINAL_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "Stripe webhook is not configured" }, 503);
    const configurationError = stripeLiveConfigurationError(c.env);
    if (configurationError) return c.json({ error: configurationError }, 503);
    const signatureHeader = c.req.header("stripe-signature");
    if (!signatureHeader) return c.json({ error: "Missing Stripe signature" }, 400);
    const rawBody = await c.req.text();
    const valid = await verifySignature({ rawBody, signatureHeader, webhookSecret: secret });
    if (!valid) return c.json({ error: "Invalid Stripe signature" }, 400);
    const db = createDb(c.env);
    if (!db) return c.json({ error: "Stripe reconciliation database is not configured" }, 503);
    let event: Parameters<typeof processStripeEvent>[0]["event"];
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return c.json({ error: "Invalid Stripe event" }, 400);
    }
    try {
      const result = await processEvent({ db, env: c.env, rawBody, event });
      if ("paidTransactionId" in result && result.paidTransactionId) {
        c.executionCtx.waitUntil(deliverPaidTransactionNotifications({ db, env: c.env, transactionId: result.paidTransactionId }).then(() => undefined));
      }
      return c.json({ received: result.received, duplicate: "duplicate" in result ? result.duplicate : undefined, ignored: "ignored" in result ? result.ignored : undefined });
    } catch (error) {
      console.error("Stripe reconciliation rejected an event", error instanceof Error ? error.message : "unknown error");
      return c.json(
        { error: "Stripe event could not be reconciled" },
        error instanceof StripeWebhookInputError ? 400 : 503,
      );
    }
  });
  return routes;
}

export const webhookRoutes = createWebhookRoutes();
