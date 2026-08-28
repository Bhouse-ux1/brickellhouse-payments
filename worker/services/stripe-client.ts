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
    const response = await this.fetcher(`https://api.stripe.com${path}`, {
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
