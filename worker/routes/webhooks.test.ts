import { describe, expect, it, vi } from "vitest";
import { createWebhookRoutes } from "./webhooks";
import { StripeReconciliationError, StripeWebhookInputError } from "@worker/services/stripe-reconciliation";

const env = {
  STRIPE_TERMINAL_WEBHOOK_SECRET: "whsec_placeholder",
  STRIPE_LIVE_MODE_ONLY: "true",
  STRIPE_SECRET_KEY: "rk_live_placeholder",
  STRIPE_TERMINAL_READER_ID: "tmr_live",
  STRIPE_TERMINAL_LOCATION_ID: "tml_live",
};

const event = {
  id: "evt_unrelated",
  object: "event",
  type: "payment_intent.succeeded",
  livemode: true,
  data: { object: { id: "pi_unrelated", object: "payment_intent" } },
};

describe("Stripe webhook route", () => {
  it("returns HTTP 200 ignored for a valid signed unrelated event", async () => {
    const processEvent = vi.fn(async () => ({ received: true, ignored: true }));
    const routes = createWebhookRoutes({
      verifySignature: vi.fn(async () => true),
      createDb: vi.fn(() => ({}) as never),
      processEvent: processEvent as never,
    });
    const response = await routes.request("/stripe", {
      method: "POST",
      headers: { "stripe-signature": "valid-placeholder" },
      body: JSON.stringify(event),
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("rejects an invalid webhook signature before reconciliation", async () => {
    const processEvent = vi.fn();
    const routes = createWebhookRoutes({
      verifySignature: vi.fn(async () => false),
      createDb: vi.fn(() => ({}) as never),
      processEvent: processEvent as never,
    });
    const response = await routes.request("/stripe", {
      method: "POST",
      headers: { "stripe-signature": "invalid-placeholder" },
      body: JSON.stringify(event),
    }, env);
    expect(response.status).toBe(400);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("returns a retriable failure for an owned event that cannot be safely reconciled", async () => {
    const routes = createWebhookRoutes({
      verifySignature: vi.fn(async () => true),
      createDb: vi.fn(() => ({}) as never),
      processEvent: vi.fn(async () => { throw new StripeReconciliationError("durable attempt missing"); }) as never,
    });
    const response = await routes.request("/stripe", {
      method: "POST",
      headers: { "stripe-signature": "valid-placeholder" },
      body: JSON.stringify(event),
    }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Stripe event could not be reconciled" });
  });

  it("returns 503 for temporary stripe_events database or infrastructure failures", async () => {
    const routes = createWebhookRoutes({
      verifySignature: vi.fn(async () => true),
      createDb: vi.fn(() => ({}) as never),
      processEvent: vi.fn(async () => { throw new Error("database unavailable"); }) as never,
    });
    const response = await routes.request("/stripe", {
      method: "POST", headers: { "stripe-signature": "valid-placeholder" }, body: JSON.stringify(event),
    }, env);
    expect(response.status).toBe(503);
  });

  it("keeps structurally invalid signed event input in the 400 class", async () => {
    const routes = createWebhookRoutes({
      verifySignature: vi.fn(async () => true),
      createDb: vi.fn(() => ({}) as never),
      processEvent: vi.fn(async () => { throw new StripeWebhookInputError("Invalid Stripe event"); }) as never,
    });
    const response = await routes.request("/stripe", {
      method: "POST", headers: { "stripe-signature": "valid-placeholder" }, body: JSON.stringify(event),
    }, env);
    expect(response.status).toBe(400);
  });
});
