import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { paymentAttempts, stripeEvents, transactions } from "@/db/schema";
import { markPaymentFailed, markPaymentSucceeded } from "@worker/services/payment-reconciliation";
import {
  createStripeTerminalClient, stripeReaderLocationId, validateLivePaymentIntent, validateLiveReader,
} from "@worker/services/stripe-client";
import type { StripePaymentIntent, StripeReader, StripeTerminalClient } from "@worker/services/stripe-client";
import type { WorkerBindings } from "@worker/types";

type StripeEvent = {
  id: string;
  object: "event";
  type: string;
  livemode: boolean;
  data: { object: unknown };
};

const supportedEvents = new Set([
  "terminal.reader.action_succeeded",
  "terminal.reader.action_failed",
  "terminal.reader.action_updated",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
]);

export function decideReconciliation(input: {
  eventType: string;
  paymentIntentStatus: string;
  amountReceived?: number;
  expectedAmountCents: number;
  failureCode?: string | null;
}) {
  const succeededEvent = input.eventType === "payment_intent.succeeded" || input.eventType === "terminal.reader.action_succeeded";
  if (succeededEvent && input.paymentIntentStatus === "succeeded" && input.amountReceived === input.expectedAmountCents) return "SUCCEEDED" as const;
  if (input.eventType === "terminal.reader.action_failed" || input.eventType === "payment_intent.payment_failed") {
    if (input.failureCode === "connection_error" && !["requires_payment_method", "canceled"].includes(input.paymentIntentStatus)) return "PROCESSING" as const;
    if (input.failureCode === "customer_canceled" || input.paymentIntentStatus === "canceled") return "CANCELED" as const;
    return "FAILED" as const;
  }
  return "PROCESSING" as const;
}

function isPaymentIntent(value: unknown): value is StripePaymentIntent {
  return Boolean(value && typeof value === "object" && (value as { object?: unknown }).object === "payment_intent" && typeof (value as { id?: unknown }).id === "string");
}

function isReader(value: unknown): value is StripeReader {
  return Boolean(value && typeof value === "object" && (value as { object?: unknown }).object === "terminal.reader" && typeof (value as { id?: unknown }).id === "string");
}

function referencedPaymentIntent(value: unknown): string | null {
  if (isPaymentIntent(value)) return value.id;
  if (!isReader(value)) return null;
  const reference = value.action?.process_payment_intent?.payment_intent;
  return typeof reference === "string" ? reference : reference?.id ?? null;
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function processStripeEvent(input: {
  db: Database;
  env: WorkerBindings;
  rawBody: string;
  event: StripeEvent;
  stripe?: StripeTerminalClient;
}) {
  const event = input.event;
  if (!event.id || event.object !== "event" || !event.type || !event.data) throw new Error("Invalid Stripe event.");
  if (!event.livemode) throw new Error("Test-mode Stripe events are rejected.");

  const payloadSha256 = await sha256Hex(input.rawBody);
  const [inserted] = await input.db.insert(stripeEvents).values({
    stripeEventId: event.id,
    eventType: event.type,
    liveMode: event.livemode,
    payloadSha256,
  }).onConflictDoNothing().returning({ id: stripeEvents.id });
  let eventRowId = inserted?.id;
  if (!eventRowId) {
    const [existing] = await input.db.select().from(stripeEvents).where(eq(stripeEvents.stripeEventId, event.id)).limit(1);
    if (!existing || existing.payloadSha256 !== payloadSha256) throw new Error("Stripe event identity or payload is inconsistent.");
    if (existing.processedAt) return { received: true, duplicate: true };
    eventRowId = existing.id;
  }

  try {
    if (!supportedEvents.has(event.type)) {
      await input.db.update(stripeEvents).set({ processedAt: new Date() }).where(eq(stripeEvents.id, eventRowId));
      return { received: true, ignored: true };
    }

    const stripeObject = event.data.object;
    if (isReader(stripeObject) && stripeObject.action?.type !== "process_payment_intent") {
      await input.db.update(stripeEvents).set({ processedAt: new Date() }).where(eq(stripeEvents.id, eventRowId));
      return { received: true, ignored: true };
    }
    const paymentIntentId = referencedPaymentIntent(stripeObject);
    if (!paymentIntentId) throw new Error("Stripe event does not reference a PaymentIntent.");
    const [attempt] = await input.db.select().from(paymentAttempts)
      .where(eq(paymentAttempts.stripePaymentIntentId, paymentIntentId)).limit(1);
    if (!attempt) throw new Error("Stripe event references an unknown PaymentIntent.");
    const [transaction] = await input.db.select().from(transactions)
      .where(eq(transactions.id, attempt.transactionId)).limit(1);
    if (!transaction || transaction.stripePaymentIntentId !== paymentIntentId) throw new Error("Stripe PaymentIntent relationship is invalid.");

    const stripe = input.stripe ?? createStripeTerminalClient(input.env);
    const paymentIntent = await stripe.retrievePaymentIntent(paymentIntentId);
    validateLivePaymentIntent({
      paymentIntent,
      expectedPaymentIntentId: paymentIntentId,
      transactionId: transaction.id,
      transactionNumber: transaction.number,
      amountCents: transaction.totalCents,
    });
    if (paymentIntent.status === "succeeded" && paymentIntent.amount_received !== transaction.totalCents) {
      throw new Error("Stripe received amount does not match the transaction.");
    }

    let readerId = transaction.stripeReaderId ?? input.env.STRIPE_TERMINAL_READER_ID ?? "";
    let locationId = transaction.stripeLocationId ?? input.env.STRIPE_TERMINAL_LOCATION_ID ?? "";
    if (isReader(stripeObject)) {
      validateLiveReader(stripeObject, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
      readerId = stripeObject.id;
      locationId = stripeReaderLocationId(stripeObject) ?? "";
    } else if (readerId !== input.env.STRIPE_TERMINAL_READER_ID || locationId !== input.env.STRIPE_TERMINAL_LOCATION_ID) {
      throw new Error("Stored reader or location does not match configuration.");
    }

    const failureCode = isReader(stripeObject) ? stripeObject.action?.failure_code ?? null : null;
    const decision = decideReconciliation({
      eventType: event.type,
      paymentIntentStatus: paymentIntent.status,
      amountReceived: paymentIntent.amount_received,
      expectedAmountCents: transaction.totalCents,
      failureCode,
    });
    if (decision === "SUCCEEDED") {
      await markPaymentSucceeded({
        db: input.db,
        transactionId: transaction.id,
        paymentAttemptId: attempt.id,
        paymentIntent,
        readerId,
        locationId,
        customerEmail: transaction.customerEmail,
      });
    } else if (decision === "PROCESSING") {
      if (failureCode === "connection_error") {
        await input.db.update(paymentAttempts).set({ status: "PROCESSING", lastErrorCode: failureCode, lastErrorMessage: "Stripe state is being reconciled.", updatedAt: new Date() })
          .where(eq(paymentAttempts.id, attempt.id));
      } else {
        await input.db.update(paymentAttempts).set({ status: "PROCESSING", updatedAt: new Date() }).where(eq(paymentAttempts.id, attempt.id));
      }
      await input.db.update(transactions).set({ paymentStatus: "PROCESSING", updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
    } else {
      await markPaymentFailed({
        db: input.db,
        transactionId: transaction.id,
        paymentAttemptId: attempt.id,
        code: failureCode ?? "payment_failed",
        message: isReader(stripeObject) ? stripeObject.action?.failure_message ?? "Payment declined" : "Payment declined",
        canceled: decision === "CANCELED",
      });
    }

    await input.db.update(stripeEvents).set({ processedAt: new Date(), processingError: null }).where(eq(stripeEvents.id, eventRowId));
    return { received: true, duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe reconciliation failed";
    await input.db.update(stripeEvents).set({ processingError: message }).where(eq(stripeEvents.id, eventRowId));
    throw error;
  }
}
