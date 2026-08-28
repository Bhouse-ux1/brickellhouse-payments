import type { WorkerBindings } from "@worker/types";

export type StripeCharge = {
  id: string;
  payment_method_details?: { card_present?: { brand?: string; last4?: string } };
};

export type StripePaymentIntent = {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received?: number;
  currency: string;
  status: string;
  livemode: boolean;
  payment_method_types?: string[];
  metadata: Record<string, string>;
  latest_charge?: string | StripeCharge | null;
};

export type StripeReaderCart = {
  currency: "usd";
  lineItems: Array<{ amountCents: number; description: string; quantity: number }>;
  totalCents: number;
};

export type StripeReader = {
  id: string;
  object: "terminal.reader";
  livemode: boolean;
  location: string | { id?: string } | null;
  status?: string;
  action?: {
    type?: string;
    status?: string;
    failure_code?: string | null;
    failure_message?: string | null;
    process_payment_intent?: { payment_intent?: string | StripePaymentIntent };
    set_reader_display?: {
      type?: string;
      cart?: {
        currency?: string;
        line_items?: Array<{ amount?: number; description?: string; quantity?: number }>;
        total?: number;
      };
    };
  } | null;
};

export class StripeApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "StripeApiError";
  }
}

export interface StripeTerminalClient {
  createPaymentIntent(input: {
    amountCents: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<StripePaymentIntent>;
  retrievePaymentIntent(id: string): Promise<StripePaymentIntent>;
  retrieveReader(id: string): Promise<StripeReader>;
  setReaderDisplay(input: { readerId: string; cart: StripeReaderCart; idempotencyKey: string }): Promise<StripeReader>;
  processPaymentIntent(input: { readerId: string; paymentIntentId: string; idempotencyKey: string }): Promise<StripeReader>;
  cancelReaderAction(input: { readerId: string; idempotencyKey: string }): Promise<StripeReader>;
}

export function isApprovedLiveStripeKey(value: string | undefined): boolean {
  return Boolean(value?.startsWith("rk_live_"));
}

export function stripeLiveConfigurationError(env: WorkerBindings): string | null {
  if (env.STRIPE_LIVE_MODE_ONLY !== "true") return "Stripe live-only mode is not enabled";
  if (!env.STRIPE_SECRET_KEY) return "Stripe is not configured";
  if (!isApprovedLiveStripeKey(env.STRIPE_SECRET_KEY)) return "Only the approved live restricted Stripe key is accepted";
  if (!env.STRIPE_TERMINAL_READER_ID || !env.STRIPE_TERMINAL_LOCATION_ID) return "The configured S710 is incomplete";
  return null;
}

export function stripeReaderLocationId(reader: StripeReader): string | null {
  return typeof reader.location === "string" ? reader.location : reader.location?.id ?? null;
}

export function validateLiveReader(reader: StripeReader, expectedReaderId: string, expectedLocationId: string): void {
  if (reader.object !== "terminal.reader" || !reader.livemode) throw new Error("Stripe reader is not a live-mode Terminal reader.");
  if (reader.id !== expectedReaderId) throw new Error("Stripe reader identity does not match configuration.");
  if (stripeReaderLocationId(reader) !== expectedLocationId) throw new Error("Stripe reader location does not match configuration.");
}

export function validateReaderDisplayState(reader: StripeReader, expectedCart: StripeReaderCart): "PENDING" | "SUCCEEDED" {
  const action = reader.action;
  if (action?.type !== "set_reader_display") throw new Error("Stripe reader did not acknowledge the cart display action.");
  if (action.status === "failed") throw new Error(action.failure_message ?? "Stripe reader cart display failed.");
  if (action.status !== "in_progress" && action.status !== "succeeded") throw new Error("Stripe reader cart display state is uncertain.");

  const displayedCart = action.set_reader_display?.cart;
  if (!displayedCart || action.set_reader_display?.type !== "cart") throw new Error("Stripe reader did not return the expected cart display.");
  if (displayedCart.currency !== expectedCart.currency || displayedCart.total !== expectedCart.totalCents) {
    throw new Error("Stripe reader cart total does not match the payment amount.");
  }
  if (displayedCart.line_items?.length !== expectedCart.lineItems.length) throw new Error("Stripe reader cart items are incomplete.");
  expectedCart.lineItems.forEach((expected, index) => {
    const displayed = displayedCart.line_items?.[index];
    if (!displayed || displayed.amount !== expected.amountCents || displayed.description !== expected.description || displayed.quantity !== expected.quantity) {
      throw new Error("Stripe reader cart item does not match the trusted transaction.");
    }
  });
  return action.status === "succeeded" ? "SUCCEEDED" : "PENDING";
}

export function validateLivePaymentIntent(input: {
  paymentIntent: StripePaymentIntent;
  expectedPaymentIntentId?: string | null;
  transactionId: string;
  transactionNumber: string;
  amountCents: number;
}): void {
  const intent = input.paymentIntent;
  if (intent.object !== "payment_intent" || !intent.livemode) throw new Error("Stripe PaymentIntent is not live mode.");
  if (input.expectedPaymentIntentId && intent.id !== input.expectedPaymentIntentId) throw new Error("Unexpected Stripe PaymentIntent.");
  if (intent.amount !== input.amountCents) throw new Error("Stripe PaymentIntent amount does not match the transaction.");
  if (intent.status === "succeeded" && intent.amount_received !== input.amountCents) throw new Error("Stripe received amount does not match the transaction.");
  if (intent.currency.toLowerCase() !== "usd") throw new Error("Stripe PaymentIntent currency must be USD.");
  if (!intent.payment_method_types?.includes("card_present")) throw new Error("Stripe PaymentIntent is not card-present.");
  if (intent.metadata.source !== "brickellhouse_payments" || intent.metadata.internal_transaction_id !== input.transactionId ||
      intent.metadata.transaction_number !== input.transactionNumber) {
    throw new Error("Stripe PaymentIntent relationship does not match the transaction.");
  }
}

class FetchStripeTerminalClient implements StripeTerminalClient {
  constructor(private readonly secretKey: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(method: "GET" | "POST", path: string, parameters?: URLSearchParams, idempotencyKey?: string): Promise<T> {
    // Cloudflare's native fetch must keep the global execution-context receiver.
    // Calling it as `this.fetcher(...)` binds it to this client and throws
    // "Illegal invocation" before any request reaches Stripe.
    const response = await this.fetcher.call(globalThis, `https://api.stripe.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(parameters ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: parameters,
    });
    const body = await response.json() as T & { error?: { code?: string; message?: string } };
    if (!response.ok) throw new StripeApiError(body.error?.code ?? "stripe_error", body.error?.message ?? "Stripe request failed", response.status);
    return body;
  }

  createPaymentIntent(input: { amountCents: number; idempotencyKey: string; metadata: Record<string, string> }): Promise<StripePaymentIntent> {
    const form = new URLSearchParams({ amount: String(input.amountCents), currency: "usd", capture_method: "automatic" });
    form.append("payment_method_types[]", "card_present");
    form.append("expand[]", "latest_charge");
    for (const [key, value] of Object.entries(input.metadata)) form.append(`metadata[${key}]`, value);
    return this.request("POST", "/v1/payment_intents", form, input.idempotencyKey);
  }

  retrievePaymentIntent(id: string): Promise<StripePaymentIntent> {
    return this.request("GET", `/v1/payment_intents/${encodeURIComponent(id)}?expand%5B%5D=latest_charge`);
  }

  retrieveReader(id: string): Promise<StripeReader> {
    return this.request("GET", `/v1/terminal/readers/${encodeURIComponent(id)}`);
  }

  setReaderDisplay(input: { readerId: string; cart: StripeReaderCart; idempotencyKey: string }): Promise<StripeReader> {
    const form = new URLSearchParams({
      type: "cart",
      "cart[currency]": input.cart.currency,
      "cart[total]": String(input.cart.totalCents),
    });
    input.cart.lineItems.forEach((item, index) => {
      form.append(`cart[line_items][${index}][amount]`, String(item.amountCents));
      form.append(`cart[line_items][${index}][description]`, item.description);
      form.append(`cart[line_items][${index}][quantity]`, String(item.quantity));
    });
    return this.request("POST", `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/set_reader_display`, form, input.idempotencyKey);
  }

  processPaymentIntent(input: { readerId: string; paymentIntentId: string; idempotencyKey: string }): Promise<StripeReader> {
    const form = new URLSearchParams({ payment_intent: input.paymentIntentId, "process_config[enable_customer_cancellation]": "true" });
    return this.request("POST", `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/process_payment_intent`, form, input.idempotencyKey);
  }

  cancelReaderAction(input: { readerId: string; idempotencyKey: string }): Promise<StripeReader> {
    return this.request("POST", `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/cancel_action`, new URLSearchParams(), input.idempotencyKey);
  }
}

export function createStripeTerminalClient(env: WorkerBindings, fetcher: typeof fetch = fetch): StripeTerminalClient {
  const error = stripeLiveConfigurationError(env);
  if (error || !env.STRIPE_SECRET_KEY) throw new Error(error ?? "Stripe is not configured");
  return new FetchStripeTerminalClient(env.STRIPE_SECRET_KEY, fetcher);
}
