import { describe, expect, it, vi } from "vitest";
import {
  createStripeTerminalClient, stripeLiveConfigurationError,
  validateLivePaymentIntent, validateLiveReader, validateReaderDisplayState,
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

  it("invokes the Stripe fetcher with Cloudflare's global receiver", async () => {
    const fetcher = vi.fn(function (this: typeof globalThis, url: string | URL | Request) {
      expect(this).toBe(globalThis);
      expect(String(url)).toContain("/v1/terminal/readers/tmr_live");
      return Promise.resolve(new Response(JSON.stringify({
        id: "tmr_live", object: "terminal.reader", livemode: true, location: "tml_live", status: "online",
      }), { status: 200 }));
    });

    const client = createStripeTerminalClient(liveEnv, fetcher as typeof fetch);
    await expect(client.retrieveReader("tmr_live")).resolves.toMatchObject({ id: "tmr_live", status: "online" });
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

  it("sends the trusted cart total and the identical PaymentIntent amount", async () => {
    const requests: Array<{ url: string; form: URLSearchParams; idempotencyKey: string | null }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = { url: String(url), form: init?.body as URLSearchParams, idempotencyKey: new Headers(init?.headers).get("idempotency-key") };
      requests.push(request);
      if (request.url.endsWith("/set_reader_display")) {
        return new Response(JSON.stringify({
          id: "tmr_live", object: "terminal.reader", livemode: true, location: "tml_live",
          action: {
            type: "set_reader_display", status: "succeeded",
            set_reader_display: {
              type: "cart",
              cart: {
                currency: "usd", total: 9_291,
                line_items: [
                  { description: "Parking Fob", amount: 5_500, quantity: 1 },
                  { description: "Mailbox Key Copy", amount: 1_000, quantity: 2 },
                  { description: "Custom Charge: Replacement part", amount: 1_500, quantity: 1 },
                  { description: "Processing Fee", amount: 291, quantity: 1 },
                ],
              },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ...trustedIntent, amount: 9_291 }), { status: 200 });
    });
    const cart = {
      currency: "usd" as const,
      lineItems: [
        { description: "Parking Fob", amountCents: 5_500, quantity: 1 },
        { description: "Mailbox Key Copy", amountCents: 1_000, quantity: 2 },
        { description: "Custom Charge: Replacement part", amountCents: 1_500, quantity: 1 },
        { description: "Processing Fee", amountCents: 291, quantity: 1 },
      ],
      totalCents: 9_291,
    };
    const client = createStripeTerminalClient(liveEnv, fetcher as typeof fetch);

    await client.setReaderDisplay({ readerId: "tmr_live", cart, idempotencyKey: "stable-attempt-key:display" });
    await client.createPaymentIntent({ amountCents: cart.totalCents, idempotencyKey: "stable-attempt-key", metadata: trustedIntent.metadata });

    const display = requests[0];
    const intent = requests[1];
    expect(display.url).toContain("/v1/terminal/readers/tmr_live/set_reader_display");
    expect(display.form.get("type")).toBe("cart");
    expect(display.form.get("cart[currency]")).toBe("usd");
    expect(display.form.get("cart[line_items][1][amount]")).toBe("1000");
    expect(display.form.get("cart[line_items][1][quantity]")).toBe("2");
    expect(display.form.get("cart[line_items][2][description]")).toBe("Custom Charge: Replacement part");
    expect(display.form.get("cart[line_items][3][description]")).toBe("Processing Fee");
    expect(display.form.get("cart[total]")).toBe(intent.form.get("amount"));
    expect(display.idempotencyKey).toBe("stable-attempt-key:display");
  });

  it("does not accept a failed or amount-mismatched reader display", () => {
    const cart = { currency: "usd" as const, lineItems: [{ description: "Processing Fee", amountCents: 291, quantity: 1 }], totalCents: 291 };
    const reader = {
      id: "tmr_live", object: "terminal.reader" as const, livemode: true, location: "tml_live",
      action: {
        type: "set_reader_display", status: "succeeded",
        set_reader_display: { type: "cart", cart: { currency: "usd", total: 291, line_items: [{ description: "Processing Fee", amount: 291, quantity: 1 }] } },
      },
    };
    expect(validateReaderDisplayState(reader, cart)).toBe("SUCCEEDED");
    expect(validateReaderDisplayState({ ...reader, action: { ...reader.action, status: "in_progress" } }, cart)).toBe("PENDING");
    expect(() => validateReaderDisplayState({ ...reader, action: { ...reader.action, status: "failed", failure_message: "display failed" } }, cart)).toThrow(/display failed/u);
    expect(() => validateReaderDisplayState({ ...reader, action: { ...reader.action, set_reader_display: { ...reader.action.set_reader_display, cart: { ...reader.action.set_reader_display.cart, total: 292 } } } }, cart)).toThrow(/total/u);
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
