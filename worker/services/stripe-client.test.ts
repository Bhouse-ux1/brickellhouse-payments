import { describe, expect, it, vi } from "vitest";
import {
  createStripeTerminalClient, stripeLiveConfigurationError,
  validateLivePaymentIntent, validateLiveReader,
} from "./stripe-client";

const liveEnv = {
  STRIPE_LIVE_MODE_ONLY: "true",
  STRIPE_SECRET_KEY: "rk_live_placeholder",
  STRIPE_TERMINAL_READER_ID: "tmr_live",
  STRIPE_TERMINAL_LOCATION_ID: "tml_live",
};

const trustedIntent = {
  id: "pi_live",
  object: "payment_intent" as const,
  amount: 10_000,
  amount_received: 10_000,
  currency: "usd",
  status: "succeeded",
  livemode: true,
  payment_method_types: ["card_present"],
  metadata: {
    source: "brickellhouse_payments",
    internal_transaction_id: "txn-1",
    transaction_number: "POS-000001",
  },
};

describe("live Stripe boundary", () => {
  it("accepts the approved live restricted key and rejects test or non-restricted keys", () => {
    expect(stripeLiveConfigurationError(liveEnv)).toBeNull();
    expect(stripeLiveConfigurationError({ ...liveEnv, STRIPE_SECRET_KEY: "sk_test_placeholder" })).toMatch(/live restricted Stripe key/u);
    expect(stripeLiveConfigurationError({ ...liveEnv, STRIPE_SECRET_KEY: "rk_test_placeholder" })).toMatch(/live restricted Stripe key/u);
    expect(stripeLiveConfigurationError({ ...liveEnv, STRIPE_SECRET_KEY: "sk_live_placeholder" })).toMatch(/live restricted Stripe key/u);
    expect(stripeLiveConfigurationError({ ...liveEnv, STRIPE_LIVE_MODE_ONLY: "false" })).toMatch(/not enabled/u);
  });

  it("creates the exact authoritative card-present automatic-capture PaymentIntent", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get("amount")).toBe("10000");
      expect(form.get("currency")).toBe("usd");
      expect(form.get("capture_method")).toBe("automatic");
      expect(form.getAll("payment_method_types[]")).toEqual(["card_present"]);
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("stable-attempt-key");
      return new Response(JSON.stringify(trustedIntent), { status: 200 });
    });
    const client = createStripeTerminalClient(liveEnv, fetcher as typeof fetch);
    await client.createPaymentIntent({ amountCents: 10_000, idempotencyKey: "stable-attempt-key", metadata: trustedIntent.metadata });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects wrong intent identity, amount, currency, or non-live evidence", () => {
    const input = { paymentIntent: trustedIntent, expectedPaymentIntentId: "pi_live", transactionId: "txn-1", transactionNumber: "POS-000001", amountCents: 10_000 };
    expect(() => validateLivePaymentIntent(input)).not.toThrow();
    expect(() => validateLivePaymentIntent({ ...input, expectedPaymentIntentId: "pi_wrong" })).toThrow(/Unexpected/u);
    expect(() => validateLivePaymentIntent({ ...input, paymentIntent: { ...trustedIntent, amount: 9_999 } })).toThrow(/amount/u);
    expect(() => validateLivePaymentIntent({ ...input, paymentIntent: { ...trustedIntent, amount_received: 9_999 } })).toThrow(/received amount/u);
    expect(() => validateLivePaymentIntent({ ...input, paymentIntent: { ...trustedIntent, currency: "eur" } })).toThrow(/USD/u);
    expect(() => validateLivePaymentIntent({ ...input, paymentIntent: { ...trustedIntent, livemode: false } })).toThrow(/live mode/u);
  });

  it("rejects an unexpected reader or location", () => {
    const reader = { id: "tmr_live", object: "terminal.reader" as const, livemode: true, location: "tml_live" };
    expect(() => validateLiveReader(reader, "tmr_live", "tml_live")).not.toThrow();
    expect(() => validateLiveReader(reader, "tmr_wrong", "tml_live")).toThrow(/identity/u);
    expect(() => validateLiveReader(reader, "tmr_live", "tml_wrong")).toThrow(/location/u);
  });

  it("sends only the configured reader and existing PaymentIntent to the server-driven API", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/terminal/readers/tmr_live/process_payment_intent");
      const form = init?.body as URLSearchParams;
      expect(form.get("payment_intent")).toBe("pi_live");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("stable-attempt-key:reader");
      return new Response(JSON.stringify({ id: "tmr_live", object: "terminal.reader", livemode: true, location: "tml_live" }), { status: 200 });
    });
    const client = createStripeTerminalClient(liveEnv, fetcher as typeof fetch);
    await client.processPaymentIntent({ readerId: "tmr_live", paymentIntentId: "pi_live", idempotencyKey: "stable-attempt-key:reader" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
