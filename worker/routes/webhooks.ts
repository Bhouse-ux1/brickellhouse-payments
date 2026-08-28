import { Hono } from "hono";
import { verifyStripeWebhookSignature } from "@worker/services/stripe-webhook";
import { createDatabase } from "@/db/client";
import { processStripeEvent } from "@worker/services/stripe-reconciliation";
import { stripeLiveConfigurationError } from "@worker/services/stripe-client";
import type { WorkerEnvironment } from "@worker/types";

export const webhookRoutes = new Hono<WorkerEnvironment>();
webhookRoutes.post("/stripe", async (c) => {
  const secret = c.env.STRIPE_TERMINAL_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Stripe webhook is not configured" }, 503);
  const configurationError = stripeLiveConfigurationError(c.env);
  if (configurationError) return c.json({ error: configurationError }, 503);
  const signatureHeader = c.req.header("stripe-signature");
  if (!signatureHeader) return c.json({ error: "Missing Stripe signature" }, 400);
  const rawBody = await c.req.text();
  const valid = await verifyStripeWebhookSignature({ rawBody, signatureHeader, webhookSecret: secret });
  if (!valid) return c.json({ error: "Invalid Stripe signature" }, 400);
  const db = createDatabase(c.env);
  if (!db) return c.json({ error: "Stripe reconciliation database is not configured" }, 503);
  let event: Parameters<typeof processStripeEvent>[0]["event"];
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return c.json({ error: "Invalid Stripe event" }, 400);
  }
  try {
    return c.json(await processStripeEvent({ db, env: c.env, rawBody, event }));
  } catch (error) {
    console.error("Stripe reconciliation rejected an event", error instanceof Error ? error.message : "unknown error");
    return c.json({ error: "Stripe event could not be reconciled" }, 400);
  }
});
