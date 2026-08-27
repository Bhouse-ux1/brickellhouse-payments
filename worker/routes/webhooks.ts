import { Hono } from "hono";
import { verifyStripeWebhookSignature } from "@worker/services/stripe-webhook";
import type { WorkerEnvironment } from "@worker/types";

export const webhookRoutes = new Hono<WorkerEnvironment>();
webhookRoutes.post("/stripe", async (c) => {
  const secret = c.env.STRIPE_TERMINAL_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Stripe webhook is not configured" }, 503);
  const signatureHeader = c.req.header("stripe-signature");
  if (!signatureHeader) return c.json({ error: "Missing Stripe signature" }, 400);
  const rawBody = await c.req.text();
  const valid = await verifyStripeWebhookSignature({ rawBody, signatureHeader, webhookSecret: secret });
  if (!valid) return c.json({ error: "Invalid Stripe signature" }, 400);
  // Deliberately non-2xx until event persistence, mode/amount/currency reconciliation,
  // reader release, state changes, and receipt enqueueing are implemented atomically.
  return c.json({ error: "Stripe reconciliation is not enabled" }, 501);
});
