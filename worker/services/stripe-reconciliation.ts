import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  paymentAttempts, stripeEvents, terminalReaderObservations, terminalReaders, transactions,
} from "@/db/schema";
import { markPaymentFailed, reconcileTerminalPaymentSuccess } from "@worker/services/payment-reconciliation";
import {
  classifyStripePaymentIntentOwnership, createStripeTerminalClient, validateLivePaymentIntent, validateLiveReader,
} from "@worker/services/stripe-client";
import type {
  StripePaymentIntent, StripePaymentIntentOwnership, StripeReader, StripeTerminalClient,
} from "@worker/services/stripe-client";
import type { WorkerBindings } from "@worker/types";

type StripeEvent = {
  id: string;
  object: "event";
  type: string;
  livemode: boolean;
  data: { object: unknown };
};

type PaymentContext = {
  attempt: typeof paymentAttempts.$inferSelect;
  transaction: typeof transactions.$inferSelect;
  recovered: boolean;
};

const supportedEvents = new Set([
  "terminal.reader.action_succeeded",
  "terminal.reader.action_failed",
  "terminal.reader.action_updated",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
]);

const recoverableAttemptStatuses = [
  "CREATED", "READER_RESERVED", "PAYMENT_INTENT_CREATED", "SENT_TO_READER", "WAITING_FOR_CUSTOMER", "PROCESSING",
] as const;

const recoverableTransactionStatuses = [
  "DRAFT", "READY", "SENDING_TO_TERMINAL", "WAITING_FOR_CUSTOMER", "PROCESSING", "TERMINAL_BUSY", "TERMINAL_OFFLINE",
] as const;

export class StripeReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeReconciliationError";
  }
}

export class StripeWebhookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeWebhookInputError";
  }
}

function reconciliationLog(action: string, details: Record<string, string | boolean | null | undefined>) {
  console.info("stripe_reconciliation", { action, ...details });
}

export function decideReconciliation(input: {
  eventType: string;
  paymentIntentStatus: string;
  amountReceived?: number;
  expectedAmountCents: number;
  failureCode?: string | null;
}) {
  if (input.paymentIntentStatus === "succeeded") {
    return input.amountReceived === input.expectedAmountCents ? "SUCCEEDED" as const : "PROCESSING" as const;
  }
  if (["processing", "requires_capture"].includes(input.paymentIntentStatus)) return "PROCESSING" as const;
  if (input.paymentIntentStatus === "canceled") return "CANCELED" as const;
  if (input.eventType === "terminal.reader.action_failed" || input.eventType === "payment_intent.payment_failed") {
    if (input.failureCode === "connection_error") return "PROCESSING" as const;
    if (input.failureCode === "customer_canceled") return "CANCELED" as const;
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

function validateTerminalReaderEvent(eventType: string, reader: StripeReader) {
  const action = reader.action;
  if (!action?.type || !action.status) {
    if (eventType === "terminal.reader.action_updated") return false;
    throw new StripeReconciliationError("Stripe Terminal event has no complete Reader action.");
  }
  if (!["in_progress", "succeeded", "failed"].includes(action.status)) {
    throw new StripeReconciliationError("Stripe Terminal event has an unsupported Reader action status.");
  }
  if (eventType === "terminal.reader.action_succeeded" && action.status !== "succeeded") {
    throw new StripeReconciliationError("Stripe Reader success event does not contain a succeeded action.");
  }
  if (eventType === "terminal.reader.action_failed" && action.status !== "failed") {
    throw new StripeReconciliationError("Stripe Reader failure event does not contain a failed action.");
  }
  return true;
}

export async function persistOwnedReaderObservation(input: {
  db: Database;
  eventId: string;
  reader: StripeReader;
  paymentIntentId: string;
  context: PaymentContext;
}) {
  const locationId = typeof input.reader.location === "string" ? input.reader.location : input.reader.location?.id;
  const actionType = input.reader.action?.type;
  const actionStatus = input.reader.action?.status;
  if (!locationId || actionType !== "process_payment_intent" ||
      !actionStatus || !["in_progress", "succeeded", "failed"].includes(actionStatus)) {
    throw new StripeReconciliationError("Stripe Reader observation is incomplete.");
  }
  const values = {
    stripeEventId: input.eventId,
    readerId: input.reader.id,
    locationId,
    liveMode: input.reader.livemode,
    actionType,
    actionStatus,
    stripePaymentIntentId: input.paymentIntentId,
    paymentAttemptId: input.context.attempt.id,
    transactionId: input.context.transaction.id,
    observedAt: new Date(),
  };
  await input.db.transaction(async (tx) => {
    const [inserted] = await tx.insert(terminalReaderObservations).values(values)
      .onConflictDoNothing().returning({ id: terminalReaderObservations.id });
    if (inserted) return;
    const [existing] = await tx.select().from(terminalReaderObservations)
      .where(eq(terminalReaderObservations.stripeEventId, input.eventId)).limit(1);
    if (!existing || existing.readerId !== values.readerId || existing.locationId !== values.locationId ||
        existing.liveMode !== values.liveMode || existing.actionType !== values.actionType ||
        existing.actionStatus !== values.actionStatus || existing.stripePaymentIntentId !== values.stripePaymentIntentId ||
        existing.paymentAttemptId !== values.paymentAttemptId || existing.transactionId !== values.transactionId) {
      throw new StripeReconciliationError("Stripe Reader event conflicts with its durable observation.");
    }
  });
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadPaymentContextByIntent(db: Database, paymentIntentId: string): Promise<PaymentContext | null> {
  const [attempt] = await db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.stripePaymentIntentId, paymentIntentId)).limit(1);
  if (!attempt) return null;
  const [transaction] = await db.select().from(transactions)
    .where(eq(transactions.id, attempt.transactionId)).limit(1);
  if (!transaction || transaction.stripePaymentIntentId !== paymentIntentId) return null;
  return { attempt, transaction, recovered: false };
}

export async function recoverOwnedPaymentContext(input: {
  db: Database;
  env: WorkerBindings;
  paymentIntent: StripePaymentIntent;
  ownership: Extract<StripePaymentIntentOwnership, { classification: "OWNED" }>;
}): Promise<PaymentContext> {
  const [candidateAttempt] = await input.db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.id, input.ownership.attemptId)).limit(1);
  if (!candidateAttempt) throw new StripeReconciliationError("Owned Stripe PaymentIntent has no durable payment attempt.");
  const [candidateTransaction] = await input.db.select().from(transactions)
    .where(eq(transactions.id, candidateAttempt.transactionId)).limit(1);
  if (!candidateTransaction) throw new StripeReconciliationError("Owned Stripe PaymentIntent has no durable transaction.");
  if (candidateAttempt.transactionId !== input.ownership.transactionId || candidateTransaction.id !== input.ownership.transactionId) {
    throw new StripeReconciliationError("Owned Stripe PaymentIntent transaction metadata conflicts with the payment attempt.");
  }
  if (candidateAttempt.expectedAmountCents !== candidateTransaction.totalCents) {
    throw new StripeReconciliationError("Payment attempt amount conflicts with its transaction.");
  }
  if (candidateAttempt.stripePaymentIntentId && candidateAttempt.stripePaymentIntentId !== input.paymentIntent.id) {
    throw new StripeReconciliationError("Payment attempt already belongs to another PaymentIntent.");
  }
  if (candidateTransaction.stripePaymentIntentId && candidateTransaction.stripePaymentIntentId !== input.paymentIntent.id) {
    throw new StripeReconciliationError("Transaction already belongs to another PaymentIntent.");
  }
  if (candidateTransaction.stripeChargeId) {
    throw new StripeReconciliationError("Owned PaymentIntent recovery conflicts with an existing Stripe Charge.");
  }
  if (candidateTransaction.paidAt) {
    throw new StripeReconciliationError("Owned PaymentIntent recovery conflicts with existing paid-at evidence.");
  }
  if (candidateTransaction.paymentMethod) {
    throw new StripeReconciliationError("Owned PaymentIntent recovery conflicts with an existing payment method.");
  }
  if (candidateTransaction.paymentStatus === "PAID") {
    throw new StripeReconciliationError("Owned PaymentIntent recovery conflicts with a finalized transaction.");
  }
  if ((candidateTransaction.stripeReaderId && candidateTransaction.stripeReaderId !== input.env.STRIPE_TERMINAL_READER_ID) ||
      (candidateTransaction.stripeLocationId && candidateTransaction.stripeLocationId !== input.env.STRIPE_TERMINAL_LOCATION_ID)) {
    throw new StripeReconciliationError("Owned PaymentIntent recovery conflicts with existing reader identity evidence.");
  }
  if (candidateTransaction.cardBrand || candidateTransaction.cardLastFour) {
    throw new StripeReconciliationError("Owned PaymentIntent recovery conflicts with existing card identity evidence.");
  }
  validateLivePaymentIntent({
    paymentIntent: input.paymentIntent,
    expectedPaymentIntentId: input.paymentIntent.id,
    paymentAttemptId: candidateAttempt.id,
    transactionId: candidateTransaction.id,
    transactionNumber: candidateTransaction.number,
    amountCents: candidateTransaction.totalCents,
  });
  if (!candidateAttempt.terminalReaderId) {
    throw new StripeReconciliationError("Owned PaymentIntent attempt has no durable reader reservation.");
  }
  const [candidateReader] = await input.db.select().from(terminalReaders)
    .where(eq(terminalReaders.id, candidateAttempt.terminalReaderId)).limit(1);
  if (!candidateReader || candidateReader.stripeReaderId !== input.env.STRIPE_TERMINAL_READER_ID ||
      candidateReader.stripeLocationId !== input.env.STRIPE_TERMINAL_LOCATION_ID) {
    throw new StripeReconciliationError("Owned PaymentIntent reader or location conflicts with configuration.");
  }
  if (candidateAttempt.stripeReaderOperationId &&
      candidateAttempt.stripeReaderOperationId !== `${candidateReader.stripeReaderId}:${input.paymentIntent.id}`) {
    throw new StripeReconciliationError("Owned PaymentIntent recovery conflicts with another reader operation.");
  }

  await input.db.transaction(async (tx) => {
    const [attempt] = await tx.update(paymentAttempts).set({
      stripePaymentIntentId: input.paymentIntent.id,
      updatedAt: new Date(),
    }).where(and(
      eq(paymentAttempts.id, candidateAttempt.id),
      inArray(paymentAttempts.status, [...recoverableAttemptStatuses]),
      or(isNull(paymentAttempts.stripePaymentIntentId), eq(paymentAttempts.stripePaymentIntentId, input.paymentIntent.id)),
    )).returning({ id: paymentAttempts.id });
    if (!attempt) throw new StripeReconciliationError("Payment attempt recovery lost a concurrency check.");

    const [transaction] = await tx.update(transactions).set({
      stripePaymentIntentId: input.paymentIntent.id,
      updatedAt: new Date(),
    }).where(and(
      eq(transactions.id, candidateTransaction.id),
      inArray(transactions.paymentStatus, [...recoverableTransactionStatuses]),
      or(isNull(transactions.stripePaymentIntentId), eq(transactions.stripePaymentIntentId, input.paymentIntent.id)),
    )).returning({ id: transactions.id });
    if (!transaction) throw new StripeReconciliationError("Transaction recovery lost a concurrency check.");
  });

  const recovered = await loadPaymentContextByIntent(input.db, input.paymentIntent.id);
  if (!recovered || recovered.attempt.id !== candidateAttempt.id || recovered.transaction.id !== candidateTransaction.id) {
    throw new StripeReconciliationError("Recovered PaymentIntent mapping could not be confirmed.");
  }
  return { ...recovered, recovered: true };
}

export async function processStripeEvent(input: {
  db: Database;
  env: WorkerBindings;
  rawBody: string;
  event: StripeEvent;
  stripe?: StripeTerminalClient;
  finalizeSucceeded?: (input: Parameters<typeof reconcileTerminalPaymentSuccess>[0]) => Promise<unknown>;
  finalizeFailed?: typeof markPaymentFailed;
}) {
  const event = input.event;
  if (!event.id || event.object !== "event" || !event.type || !event.data) throw new StripeWebhookInputError("Invalid Stripe event.");
  if (!event.livemode) throw new StripeWebhookInputError("Test-mode Stripe events are rejected.");

  let payloadSha256: string;
  let eventRowId: string;
  try {
    payloadSha256 = await sha256Hex(input.rawBody);
    const [inserted] = await input.db.insert(stripeEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      liveMode: event.livemode,
      payloadSha256,
    }).onConflictDoNothing().returning({ id: stripeEvents.id });
    eventRowId = inserted?.id ?? "";
    if (!eventRowId) {
      const [existing] = await input.db.select().from(stripeEvents).where(eq(stripeEvents.stripeEventId, event.id)).limit(1);
      if (!existing || existing.payloadSha256 !== payloadSha256) {
        throw new Error("Stripe event identity or payload is inconsistent.");
      }
      if (existing.processedAt) return { received: true, duplicate: true };
      eventRowId = existing.id;
    }
  } catch (error) {
    throw new StripeReconciliationError(error instanceof Error ? error.message : "Stripe event ledger is unavailable.");
  }
  reconciliationLog("received", { eventId: event.id, eventType: event.type });

  try {
    if (!supportedEvents.has(event.type)) {
      await input.db.update(stripeEvents).set({ processedAt: new Date(), processingError: null }).where(eq(stripeEvents.id, eventRowId));
      reconciliationLog("ignored_unsupported", { eventId: event.id, eventType: event.type });
      return { received: true, ignored: true };
    }

    const stripeObject = event.data.object;
    const terminalReaderEvent = event.type.startsWith("terminal.reader.");
    if (terminalReaderEvent && !isReader(stripeObject)) {
      throw new StripeReconciliationError("Stripe Terminal event does not contain a Reader object.");
    }
    const hasCompleteReaderAction = isReader(stripeObject) ? validateTerminalReaderEvent(event.type, stripeObject) : false;
    if (isReader(stripeObject) && (!hasCompleteReaderAction || stripeObject.action?.type !== "process_payment_intent")) {
      await input.db.update(stripeEvents).set({ processedAt: new Date(), processingError: null }).where(eq(stripeEvents.id, eventRowId));
      reconciliationLog("ignored_reader_action", { eventId: event.id, eventType: event.type });
      return { received: true, ignored: true };
    }
    const paymentIntentId = referencedPaymentIntent(stripeObject);
    if (!paymentIntentId) throw new StripeReconciliationError("Stripe event does not reference a PaymentIntent.");
    const stripe = input.stripe ?? createStripeTerminalClient(input.env);
    const paymentIntent = await stripe.retrievePaymentIntent(paymentIntentId);
    const ownership = classifyStripePaymentIntentOwnership(paymentIntent);
    reconciliationLog("ownership_classified", {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      ownership: ownership.classification,
    });
    if (ownership.classification === "UNRELATED") {
      await input.db.update(stripeEvents).set({ processedAt: new Date(), processingError: null }).where(eq(stripeEvents.id, eventRowId));
      reconciliationLog("ignored_unrelated", { eventId: event.id, eventType: event.type, paymentIntentId, ownership: "UNRELATED" });
      return { received: true, ignored: true };
    }
    if (ownership.classification === "OWNED_INVALID") {
      throw new StripeReconciliationError(`Owned PaymentIntent metadata is invalid: ${ownership.reason}.`);
    }

    if (isReader(stripeObject)) {
      validateLiveReader(stripeObject, input.env.STRIPE_TERMINAL_READER_ID ?? "", input.env.STRIPE_TERMINAL_LOCATION_ID ?? "");
    }
    const existingContext = await loadPaymentContextByIntent(input.db, paymentIntent.id);
    reconciliationLog("attempt_lookup", {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      ownership: "OWNED",
      attemptFound: Boolean(existingContext),
      recovery: existingContext ? "not_needed" : "started",
    });
    const context = existingContext ?? await recoverOwnedPaymentContext({
      db: input.db,
      env: input.env,
      paymentIntent,
      ownership,
    });
    reconciliationLog(context.recovered ? "mapping_recovered" : "mapping_found", {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      ownership: "OWNED",
      attemptFound: true,
      recovered: context.recovered,
    });
    if (isReader(stripeObject)) {
      await persistOwnedReaderObservation({
        db: input.db,
        eventId: event.id,
        reader: stripeObject,
        paymentIntentId: paymentIntent.id,
        context,
      });
    }
    validateLivePaymentIntent({
      paymentIntent,
      expectedPaymentIntentId: paymentIntentId,
      paymentAttemptId: context.attempt.id,
      transactionId: context.transaction.id,
      transactionNumber: context.transaction.number,
      amountCents: context.transaction.totalCents,
    });
    if (paymentIntent.status === "succeeded" && paymentIntent.amount_received !== context.transaction.totalCents) {
      throw new StripeReconciliationError("Stripe received amount does not match the transaction.");
    }
    const failureCode = isReader(stripeObject) ? stripeObject.action?.failure_code ?? null : null;
    const decision = decideReconciliation({
      eventType: event.type,
      paymentIntentStatus: paymentIntent.status,
      amountReceived: paymentIntent.amount_received,
      expectedAmountCents: context.transaction.totalCents,
      failureCode,
    });
    if (decision === "SUCCEEDED") {
      const authoritativeReader = isReader(stripeObject)
        ? stripeObject
        : await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID ?? "");
      await (input.finalizeSucceeded ?? reconcileTerminalPaymentSuccess)({
        db: input.db,
        env: input.env,
        transactionId: context.transaction.id,
        paymentAttemptId: context.attempt.id,
        paymentIntent,
        authoritativeReader,
        managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL,
      });
    } else if (decision === "PROCESSING") {
      if (failureCode === "connection_error") {
        await input.db.update(paymentAttempts).set({ status: "PROCESSING", lastErrorCode: failureCode, lastErrorMessage: "Stripe state is being reconciled.", updatedAt: new Date() })
          .where(and(eq(paymentAttempts.id, context.attempt.id), ne(paymentAttempts.status, "SUCCEEDED")));
      } else {
        await input.db.update(paymentAttempts).set({ status: "PROCESSING", updatedAt: new Date() })
          .where(and(eq(paymentAttempts.id, context.attempt.id), ne(paymentAttempts.status, "SUCCEEDED")));
      }
      await input.db.update(transactions).set({ paymentStatus: "PROCESSING", updatedAt: new Date() })
        .where(and(eq(transactions.id, context.transaction.id), ne(transactions.paymentStatus, "PAID")));
    } else {
      await (input.finalizeFailed ?? markPaymentFailed)({
        db: input.db,
        transactionId: context.transaction.id,
        paymentAttemptId: context.attempt.id,
        code: failureCode ?? "payment_failed",
        message: isReader(stripeObject) ? stripeObject.action?.failure_message ?? "Payment declined" : "Payment declined",
        canceled: decision === "CANCELED",
      });
    }

    await input.db.update(stripeEvents).set({ processedAt: new Date(), processingError: null }).where(eq(stripeEvents.id, eventRowId));
    reconciliationLog("finalized", {
      eventId: event.id,
      eventType: event.type,
      paymentIntentId,
      ownership: "OWNED",
      result: decision,
    });
    return { received: true, duplicate: false, paidTransactionId: decision === "SUCCEEDED" ? context.transaction.id : undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe reconciliation failed";
    await input.db.update(stripeEvents).set({ processingError: message }).where(eq(stripeEvents.id, eventRowId));
    reconciliationLog("rejected", { eventId: event.id, eventType: event.type, reason: message });
    if (error instanceof StripeReconciliationError) throw error;
    throw new StripeReconciliationError(message);
  }
}
