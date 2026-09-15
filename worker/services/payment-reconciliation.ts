import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  emailDeliveries, paymentAttempts, terminalReaderObservations, terminalReaders, transactions,
} from "@/db/schema";
import {
  stripeReaderLocationId, validateLivePaymentIntent, validateLiveReader, validateReaderPaymentAction,
} from "@worker/services/stripe-client";
import type { StripePaymentIntent, StripeReader } from "@worker/services/stripe-client";
import type { WorkerBindings } from "@worker/types";

const finalizableAttemptStatuses = [
  "CREATED", "READER_RESERVED", "PAYMENT_INTENT_CREATED", "SENT_TO_READER", "WAITING_FOR_CUSTOMER",
  "PROCESSING", "FAILED", "SUCCEEDED",
] as const;

const finalizableTransactionStatuses = [
  "DRAFT", "READY", "SENDING_TO_TERMINAL", "WAITING_FOR_CUSTOMER", "PROCESSING", "FAILED",
  "TERMINAL_BUSY", "TERMINAL_OFFLINE",
] as const;

export class PaymentReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentReconciliationError";
  }
}

export type VerifiedTerminalSuccessEvidence = {
  paymentIntentId: string;
  chargeId: string;
  readerId: string;
  locationId: string;
  amountReceived: number;
  currency: "usd";
  liveMode: true;
  paymentIntentStatus: "succeeded";
  readerActionStatus: "succeeded";
  paymentAttemptId: string;
  transactionId: string;
  cardBrand: string | null;
  cardLastFour: string | null;
};

function paymentIntentIdForCharge(paymentIntent: StripePaymentIntent): string | null {
  const charge = typeof paymentIntent.latest_charge === "object" ? paymentIntent.latest_charge : null;
  const reference = charge?.payment_intent;
  return typeof reference === "string" ? reference : reference?.id ?? null;
}

function verifiedChargeEvidence(paymentIntent: StripePaymentIntent, expectedAmountCents: number) {
  const charge = typeof paymentIntent.latest_charge === "object" ? paymentIntent.latest_charge : null;
  if (!charge?.id || charge.object !== "charge") {
    throw new PaymentReconciliationError("Successful PaymentIntent has no expanded Stripe Charge evidence.");
  }
  if (paymentIntentIdForCharge(paymentIntent) !== paymentIntent.id) {
    throw new PaymentReconciliationError("Stripe Charge does not belong to the successful PaymentIntent.");
  }
  if (charge.paid !== true || charge.captured !== true || charge.livemode !== true ||
      charge.amount !== expectedAmountCents || charge.amount_captured !== expectedAmountCents ||
      charge.currency?.toLowerCase() !== "usd") {
    throw new PaymentReconciliationError("Stripe Charge is not consistent with the successful payment.");
  }
  const card = charge.payment_method_details?.card_present;
  return {
    chargeId: charge.id,
    cardBrand: card?.brand?.slice(0, 40) ?? null,
    cardLastFour: card?.last4?.match(/^\d{4}$/u)?.[0] ?? null,
  };
}

function exactFinalTransaction(
  transaction: typeof transactions.$inferSelect,
  evidence: VerifiedTerminalSuccessEvidence,
) {
  return transaction.paymentStatus === "PAID" && transaction.paymentMethod === "STRIPE_TERMINAL" &&
    Boolean(transaction.paidAt) && transaction.stripePaymentIntentId === evidence.paymentIntentId &&
    transaction.stripeChargeId === evidence.chargeId && transaction.stripeReaderId === evidence.readerId &&
    transaction.stripeLocationId === evidence.locationId;
}

export async function verifyTerminalPaymentForFinalization(input: {
  db: Database;
  env: WorkerBindings;
  transactionId: string;
  paymentAttemptId: string;
  paymentIntent: StripePaymentIntent;
  authoritativeReader?: StripeReader | null;
}): Promise<{ evidence: VerifiedTerminalSuccessEvidence; transaction: typeof transactions.$inferSelect }> {
  const [attempt] = await input.db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.id, input.paymentAttemptId)).limit(1);
  const [transaction] = await input.db.select().from(transactions)
    .where(eq(transactions.id, input.transactionId)).limit(1);
  if (!attempt || !transaction) throw new PaymentReconciliationError("Payment finalization records are missing.");
  if (attempt.transactionId !== transaction.id || attempt.expectedAmountCents !== transaction.totalCents) {
    throw new PaymentReconciliationError("Payment attempt relationship or amount conflicts with its transaction.");
  }
  if (attempt.stripePaymentIntentId !== input.paymentIntent.id || transaction.stripePaymentIntentId !== input.paymentIntent.id) {
    throw new PaymentReconciliationError("PaymentIntent mapping conflicts with the finalization request.");
  }
  if (!finalizableAttemptStatuses.includes(attempt.status as typeof finalizableAttemptStatuses[number])) {
    throw new PaymentReconciliationError("Payment attempt is not in a finalizable state.");
  }
  if (transaction.paymentStatus !== "PAID" &&
      !finalizableTransactionStatuses.includes(transaction.paymentStatus as typeof finalizableTransactionStatuses[number])) {
    throw new PaymentReconciliationError("Transaction is not in a finalizable state.");
  }
  validateLivePaymentIntent({
    paymentIntent: input.paymentIntent,
    expectedPaymentIntentId: attempt.stripePaymentIntentId,
    paymentAttemptId: attempt.id,
    transactionId: transaction.id,
    transactionNumber: transaction.number,
    amountCents: transaction.totalCents,
  });
  if (input.paymentIntent.status !== "succeeded" || input.paymentIntent.amount_received !== transaction.totalCents) {
    throw new PaymentReconciliationError("PaymentIntent is not an exact successful payment.");
  }
  const charge = verifiedChargeEvidence(input.paymentIntent, transaction.totalCents);
  if (transaction.stripeChargeId && transaction.stripeChargeId !== charge.chargeId) {
    throw new PaymentReconciliationError("Transaction already contains a different Stripe Charge.");
  }
  if (transaction.paidAt && transaction.paymentStatus !== "PAID") {
    throw new PaymentReconciliationError("Transaction contains conflicting paid-at evidence.");
  }
  if (transaction.paymentMethod && transaction.paymentMethod !== "STRIPE_TERMINAL") {
    throw new PaymentReconciliationError("Transaction contains a conflicting payment method.");
  }

  const [chargeOwner] = await input.db.select({ id: transactions.id }).from(transactions)
    .where(eq(transactions.stripeChargeId, charge.chargeId)).limit(1);
  if (chargeOwner && chargeOwner.id !== transaction.id) {
    throw new PaymentReconciliationError("Stripe Charge is already owned by another transaction.");
  }

  const expectedReaderId = input.env.STRIPE_TERMINAL_READER_ID ?? "";
  const expectedLocationId = input.env.STRIPE_TERMINAL_LOCATION_ID ?? "";
  let readerId: string | null = null;
  let locationId: string | null = null;
  if (input.authoritativeReader) {
    validateLiveReader(input.authoritativeReader, expectedReaderId, expectedLocationId);
    try {
      validateReaderPaymentAction(input.authoritativeReader, input.paymentIntent.id);
      if (input.authoritativeReader.action?.status === "succeeded") {
        readerId = input.authoritativeReader.id;
        locationId = stripeReaderLocationId(input.authoritativeReader);
      }
    } catch {
      // Reader.action is mutable and may now describe a newer action. Durable
      // signed-webhook evidence is checked below instead of trusting this action.
    }
  }
  if (!readerId) {
    const [observation] = await input.db.select().from(terminalReaderObservations).where(and(
      eq(terminalReaderObservations.stripePaymentIntentId, input.paymentIntent.id),
      eq(terminalReaderObservations.paymentAttemptId, attempt.id),
      eq(terminalReaderObservations.transactionId, transaction.id),
      eq(terminalReaderObservations.readerId, expectedReaderId),
      eq(terminalReaderObservations.locationId, expectedLocationId),
      eq(terminalReaderObservations.liveMode, true),
      eq(terminalReaderObservations.actionType, "process_payment_intent"),
      eq(terminalReaderObservations.actionStatus, "succeeded"),
    )).limit(1);
    if (observation) {
      if (observation.stripePaymentIntentId !== input.paymentIntent.id ||
          observation.paymentAttemptId !== attempt.id || observation.transactionId !== transaction.id ||
          observation.readerId !== expectedReaderId || observation.locationId !== expectedLocationId ||
          observation.liveMode !== true || observation.actionType !== "process_payment_intent" ||
          observation.actionStatus !== "succeeded") {
        throw new PaymentReconciliationError("Persisted Stripe reader evidence conflicts with this payment.");
      }
      readerId = observation.readerId;
      locationId = observation.locationId;
    }
  }
  if (!readerId) throw new PaymentReconciliationError("Authoritative Stripe reader evidence is unavailable.");
  if (!locationId) throw new PaymentReconciliationError("Authoritative Stripe reader location evidence is unavailable.");
  if (readerId !== expectedReaderId) throw new PaymentReconciliationError("Authoritative Stripe reader does not match configuration.");
  if (locationId !== expectedLocationId) throw new PaymentReconciliationError("Authoritative Stripe location does not match configuration.");
  if (transaction.stripeReaderId && transaction.stripeReaderId !== readerId) {
    throw new PaymentReconciliationError("Transaction contains a conflicting Stripe reader identity.");
  }
  if (transaction.stripeLocationId && transaction.stripeLocationId !== locationId) {
    throw new PaymentReconciliationError("Transaction contains a conflicting Stripe location identity.");
  }

  const evidence: VerifiedTerminalSuccessEvidence = {
    paymentIntentId: input.paymentIntent.id,
    chargeId: charge.chargeId,
    readerId,
    locationId,
    amountReceived: input.paymentIntent.amount_received,
    currency: "usd",
    liveMode: true,
    paymentIntentStatus: "succeeded",
    readerActionStatus: "succeeded",
    paymentAttemptId: attempt.id,
    transactionId: transaction.id,
    cardBrand: charge.cardBrand,
    cardLastFour: charge.cardLastFour,
  };
  if (transaction.paymentStatus === "PAID" && !exactFinalTransaction(transaction, evidence)) {
    throw new PaymentReconciliationError("PAID transaction contains conflicting final payment evidence.");
  }
  return { evidence, transaction };
}

export function buildPaidDeliveryRows(input: {
  transactionId: string;
  customerEmail: string;
  managementNotificationEmail?: string;
}): Array<typeof emailDeliveries.$inferInsert> {
  const deliveries: Array<typeof emailDeliveries.$inferInsert> = [{
    transactionId: input.transactionId,
    kind: "RESIDENT_RECEIPT",
    recipientEmail: input.customerEmail,
    status: "PENDING",
  }];
  if (input.managementNotificationEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.managementNotificationEmail)) {
    deliveries.push({
      transactionId: input.transactionId,
      kind: "MANAGEMENT_PAYMENT_CONFIRMATION",
      recipientEmail: input.managementNotificationEmail,
      status: "PENDING",
    });
  }
  return deliveries;
}

async function finalizeVerifiedTerminalPayment(input: {
  db: Database;
  evidence: VerifiedTerminalSuccessEvidence;
  customerEmail: string;
  managementNotificationEmail?: string;
  now: Date;
}) {
  const { evidence, now } = input;
  await input.db.transaction(async (tx) => {
    const [updatedAttempt] = await tx.update(paymentAttempts).set({
      status: "SUCCEEDED", completedAt: now, updatedAt: now, lastErrorCode: null, lastErrorMessage: null,
    }).where(and(
      eq(paymentAttempts.id, evidence.paymentAttemptId),
      eq(paymentAttempts.transactionId, evidence.transactionId),
      eq(paymentAttempts.stripePaymentIntentId, evidence.paymentIntentId),
      inArray(paymentAttempts.status, [...finalizableAttemptStatuses]),
    )).returning({ id: paymentAttempts.id });
    if (!updatedAttempt) {
      const [currentAttempt] = await tx.select().from(paymentAttempts)
        .where(eq(paymentAttempts.id, evidence.paymentAttemptId)).limit(1);
      if (currentAttempt?.status !== "SUCCEEDED" || currentAttempt.transactionId !== evidence.transactionId ||
          currentAttempt.stripePaymentIntentId !== evidence.paymentIntentId) {
        throw new PaymentReconciliationError("Payment attempt finalization affected no expected row.");
      }
    }

    const [updatedTransaction] = await tx.update(transactions).set({
      paymentStatus: "PAID", paymentMethod: "STRIPE_TERMINAL", paidAt: now,
      stripePaymentIntentId: evidence.paymentIntentId, stripeChargeId: evidence.chargeId,
      stripeReaderId: evidence.readerId, stripeLocationId: evidence.locationId,
      cardBrand: evidence.cardBrand, cardLastFour: evidence.cardLastFour, updatedAt: now,
    }).where(and(
      eq(transactions.id, evidence.transactionId),
      inArray(transactions.paymentStatus, [...finalizableTransactionStatuses]),
      eq(transactions.stripePaymentIntentId, evidence.paymentIntentId),
      or(isNull(transactions.stripeChargeId), eq(transactions.stripeChargeId, evidence.chargeId)),
      isNull(transactions.paidAt),
      or(isNull(transactions.paymentMethod), eq(transactions.paymentMethod, "STRIPE_TERMINAL")),
    )).returning({ id: transactions.id });
    if (!updatedTransaction) {
      const [currentTransaction] = await tx.select().from(transactions)
        .where(eq(transactions.id, evidence.transactionId)).limit(1);
      if (!currentTransaction || !exactFinalTransaction(currentTransaction, evidence)) {
        throw new PaymentReconciliationError("Transaction finalization affected no expected row.");
      }
    }

    await tx.insert(emailDeliveries).values(buildPaidDeliveryRows({
      transactionId: evidence.transactionId,
      customerEmail: input.customerEmail,
      managementNotificationEmail: input.managementNotificationEmail,
    })).onConflictDoNothing();
    await tx.update(terminalReaders).set({
      lockPaymentAttemptId: null, lockAcquiredAt: null, lockExpiresAt: null, updatedAt: now,
    }).where(eq(terminalReaders.lockPaymentAttemptId, evidence.paymentAttemptId));
  });
}

export async function reconcileTerminalPaymentSuccess(input: {
  db: Database;
  env: WorkerBindings;
  transactionId: string;
  paymentAttemptId: string;
  paymentIntent: StripePaymentIntent;
  authoritativeReader?: StripeReader | null;
  managementNotificationEmail?: string;
  now?: Date;
}) {
  const verified = await verifyTerminalPaymentForFinalization(input);
  await finalizeVerifiedTerminalPayment({
    db: input.db,
    evidence: verified.evidence,
    customerEmail: verified.transaction.customerEmail,
    managementNotificationEmail: input.managementNotificationEmail,
    now: input.now ?? new Date(),
  });
  return verified.evidence;
}

export async function markPaymentFailed(input: {
  db: Database;
  transactionId: string;
  paymentAttemptId: string;
  code: string;
  message: string;
  canceled?: boolean;
  releaseReader?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const attemptStatus = input.canceled ? "CANCELED" as const : "FAILED" as const;
  const transactionStatus = input.canceled ? "CANCELED" as const : "FAILED" as const;
  await input.db.transaction(async (tx) => {
    const [currentTransaction] = await tx.select().from(transactions)
      .where(eq(transactions.id, input.transactionId)).limit(1);
    if (!currentTransaction) throw new PaymentReconciliationError("Payment failure transition transaction is missing.");
    if (currentTransaction.paymentStatus === "PAID") return;
    const [updatedAttempt] = await tx.update(paymentAttempts).set({
      status: attemptStatus, completedAt: now, lastErrorCode: input.code.slice(0, 100),
      lastErrorMessage: input.message, updatedAt: now,
    }).where(and(eq(paymentAttempts.id, input.paymentAttemptId), ne(paymentAttempts.status, "SUCCEEDED")))
      .returning({ id: paymentAttempts.id });
    if (!updatedAttempt) {
      const [currentAttempt] = await tx.select().from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.paymentAttemptId)).limit(1);
      if (currentAttempt?.status === "SUCCEEDED") return;
      throw new PaymentReconciliationError("Payment failure transition affected no expected attempt row.");
    }
    await tx.update(transactions).set({ paymentStatus: transactionStatus, updatedAt: now })
      .where(and(eq(transactions.id, input.transactionId), ne(transactions.paymentStatus, "PAID")));
    if (input.releaseReader !== false) {
      await tx.update(terminalReaders).set({
        lockPaymentAttemptId: null, lockAcquiredAt: null, lockExpiresAt: null, updatedAt: now,
      }).where(eq(terminalReaders.lockPaymentAttemptId, input.paymentAttemptId));
    }
  });
}
