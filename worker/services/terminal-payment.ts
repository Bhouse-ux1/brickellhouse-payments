import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { createDatabase, type Database } from "@/db/client";
import { paymentAttempts, terminalReaderObservations, terminalReaders, transactionItems, transactions } from "@/db/schema";
import { buildPaymentAttemptIdempotencyKey, buildReaderProcessIdempotencyKey } from "@/domain/payments/idempotency";
import { buildTrustedReaderCart } from "@/domain/payments/reader-cart";
import type { TrustedReaderCart } from "@/domain/payments/reader-cart";
import { meetsMinimumPayment, MINIMUM_PAYMENT_MESSAGE } from "@/domain/payments/minimum-payment";
import { employeePaymentStatus } from "@/domain/payments/status-display";
import {
  extendReaderReservation, releaseReaderReservation, reserveConfiguredReader, syncConfiguredReader,
} from "@/services/terminal/reader-reservation";
import { markPaymentFailed, reconcileTerminalPaymentSuccess } from "@worker/services/payment-reconciliation";
import {
  buildBrickellHousePaymentIntentMetadata, createStripeTerminalClient, stripeLiveConfigurationError,
  stripeReaderLocationId, validateLivePaymentIntent, validateLiveReader, validateReaderDisplayState, validateReaderPaymentAction,
} from "@worker/services/stripe-client";
import type { StripePaymentIntent, StripeReader, StripeReaderCart, StripeTerminalClient } from "@worker/services/stripe-client";
import type { WorkerBindings } from "@worker/types";

type PaymentAttempt = typeof paymentAttempts.$inferSelect;
type Transaction = typeof transactions.$inferSelect;

export async function confirmPaymentIntentMapping(input: {
  db: Database;
  attemptId: string;
  transactionId: string;
  paymentIntentId: string;
}): Promise<void> {
  const [mapping] = await input.db.select({
    attemptPaymentIntentId: paymentAttempts.stripePaymentIntentId,
    transactionPaymentIntentId: transactions.stripePaymentIntentId,
  }).from(paymentAttempts)
    .innerJoin(transactions, eq(transactions.id, paymentAttempts.transactionId))
    .where(and(eq(paymentAttempts.id, input.attemptId), eq(transactions.id, input.transactionId)))
    .limit(1);
  if (mapping?.attemptPaymentIntentId !== input.paymentIntentId || mapping.transactionPaymentIntentId !== input.paymentIntentId) {
    throw new Error("PaymentIntent mapping was not durably persisted.");
  }
}

export async function persistPaymentIntentMapping(input: {
  db: Database;
  attemptId: string;
  transactionId: string;
  paymentIntentId: string;
}): Promise<void> {
  const now = new Date();
  await input.db.transaction(async (tx) => {
    const [attempt] = await tx.update(paymentAttempts).set({
      stripePaymentIntentId: input.paymentIntentId,
      status: "PAYMENT_INTENT_CREATED",
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: now,
    }).where(and(
      eq(paymentAttempts.id, input.attemptId),
      inArray(paymentAttempts.status, ["READER_RESERVED", "PAYMENT_INTENT_CREATED"]),
      or(isNull(paymentAttempts.lastErrorCode), eq(paymentAttempts.lastErrorCode, "INTENT_CREATING")),
      or(isNull(paymentAttempts.stripePaymentIntentId), eq(paymentAttempts.stripePaymentIntentId, input.paymentIntentId)),
    )).returning({ id: paymentAttempts.id });
    if (!attempt) throw new Error("PaymentIntent could not be attached to its payment attempt.");

    const [transaction] = await tx.update(transactions).set({
      stripePaymentIntentId: input.paymentIntentId,
      paymentStatus: "READY",
      updatedAt: now,
    }).where(and(
      eq(transactions.id, input.transactionId),
      inArray(transactions.paymentStatus, ["DRAFT", "READY", "SENDING_TO_TERMINAL", "TERMINAL_OFFLINE", "TERMINAL_BUSY"]),
      or(isNull(transactions.stripePaymentIntentId), eq(transactions.stripePaymentIntentId, input.paymentIntentId)),
    )).returning({ id: transactions.id });
    if (!transaction) throw new Error("PaymentIntent could not be attached to its transaction.");
  });
  await confirmPaymentIntentMapping(input);
}

export async function processAfterPaymentIntentPersistence<T>(input: {
  confirmPersisted: () => Promise<void>;
  processPaymentIntent: () => Promise<T>;
}): Promise<T> {
  await input.confirmPersisted();
  return input.processPaymentIntent();
}

export class TerminalFlowError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 404 | 409 | 503 = 409) {
    super(message);
    this.name = "TerminalFlowError";
  }
}

export type EmployeePaymentView = {
  transactionId: string;
  paymentStatus: keyof typeof employeePaymentStatus;
  displayStatus: string;
  readerDisplayPending: boolean;
  setupRecoveryRequired?: boolean;
};

async function getOrCreatePaymentAttempt(db: Database, transaction: Transaction): Promise<PaymentAttempt> {
  const [existing] = await db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.transactionId, transaction.id))
    .orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
  if (existing) return existing;
  const idempotencyKey = buildPaymentAttemptIdempotencyKey(transaction.id, 1);
  const [inserted] = await db.insert(paymentAttempts).values({
    transactionId: transaction.id,
    attemptNumber: 1,
    idempotencyKey,
    expectedAmountCents: transaction.totalCents,
    status: "CREATED",
    updatedAt: new Date(),
  }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [raced] = await db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.transactionId, transaction.id))
    .orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
  if (!raced) throw new Error("Payment attempt could not be recovered.");
  return raced;
}

function view(transactionId: string, paymentStatus: keyof typeof employeePaymentStatus): EmployeePaymentView {
  return {
    transactionId,
    paymentStatus,
    displayStatus: employeePaymentStatus[paymentStatus],
    readerDisplayPending: paymentStatus === "SENDING_TO_TERMINAL",
  };
}

function readerIntentId(reader: Awaited<ReturnType<StripeTerminalClient["processPaymentIntent"]>>): string | null {
  const value = reader.action?.process_payment_intent?.payment_intent;
  return typeof value === "string" ? value : value?.id ?? null;
}

async function setTrustedReaderDisplay(input: {
  stripe: StripeTerminalClient;
  readerId: string;
  locationId: string;
  idempotencyKey: string;
  cart: StripeReaderCart;
}) {
  const reader = await input.stripe.setReaderDisplay({
    readerId: input.readerId,
    cart: input.cart,
    idempotencyKey: `${input.idempotencyKey}:display`,
  });
  validateLiveReader(reader, input.readerId, input.locationId);
  // On a physical S710, an acknowledged cart remains in_progress for as long
  // as it is visible. That state enables S710 pre-dip: the resident may present
  // one card while this request continues to the same PaymentIntent.
  validateReaderDisplayState(reader, input.cart);
  return reader;
}

export function classifyReaderAction(reader: Awaited<ReturnType<StripeTerminalClient["retrieveReader"]>>) {
  const paymentIntentId = readerIntentId(reader);
  if (paymentIntentId || reader.action?.type === "process_payment_intent") {
    if (reader.action?.status === "in_progress") return "PAYMENT_ACTIVE" as const;
    if (reader.action?.status === "succeeded" || reader.action?.status === "failed") return "IDLE" as const;
    return "UNCERTAIN" as const;
  }
  if (!reader.action) return "IDLE" as const;
  if (reader.action.type === "set_reader_display") return "CART_DISPLAY" as const;
  return "UNCERTAIN" as const;
}

export function decideExistingPaymentIntentAction(input: {
  attemptStatus: PaymentAttempt["status"];
  paymentIntentStatus: string;
  readerAction: ReturnType<typeof classifyReaderAction>;
  readerPaymentIntentMatches: boolean;
  hasReaderOperation: boolean;
}) {
  if (input.paymentIntentStatus === "succeeded") return "RECONCILE_SUCCESS" as const;
  if (input.paymentIntentStatus === "processing") return "SHOW_PROCESSING" as const;
  if (["FAILED", "CANCELED", "EXPIRED"].includes(input.attemptStatus)) return "SHOW_FAILED" as const;
  if (input.readerAction === "PAYMENT_ACTIVE") {
    return input.readerPaymentIntentMatches ? "SHOW_WAITING" as const : "REFUSE_UNCERTAIN" as const;
  }
  if (["WAITING_FOR_CUSTOMER", "PROCESSING"].includes(input.attemptStatus) && input.hasReaderOperation) {
    return "SHOW_WAITING" as const;
  }
  if (input.paymentIntentStatus === "requires_payment_method" &&
      (["PAYMENT_INTENT_CREATED", "READER_RESERVED"].includes(input.attemptStatus) ||
       (input.attemptStatus === "SENT_TO_READER" && !input.hasReaderOperation))) {
    return "PROCESS_REUSING_INTENT" as const;
  }
  return "SHOW_PROCESSING" as const;
}

export const READER_DISPLAY_TIMEOUT_MS = 2 * 60 * 1000;

export function shouldDeferUnstartedPaymentReconciliation(input: {
  attemptStatus: PaymentAttempt["status"];
  attemptUpdatedAt: Date;
  now: Date;
}) {
  return ["CREATED", "READER_RESERVED"].includes(input.attemptStatus) &&
    input.now.getTime() - input.attemptUpdatedAt.getTime() < READER_DISPLAY_TIMEOUT_MS;
}

export function decideReaderDisplayRecovery(input: {
  readerAction: ReturnType<typeof classifyReaderAction>;
  hasPaymentIntent: boolean;
}) {
  if (input.hasPaymentIntent || input.readerAction === "PAYMENT_ACTIVE" || input.readerAction === "UNCERTAIN") {
    return "REFUSE_UNCERTAIN" as const;
  }
  if (input.readerAction === "CART_DISPLAY") return "CLEAR_VERIFIED_CART" as const;
  return "RELEASE_CONFIRMED_IDLE" as const;
}

export function decidePolledPaymentReconciliation(input: {
  paymentIntentStatus: string;
  amountReceived?: number;
  expectedAmountCents: number;
  readerAction: ReturnType<typeof classifyReaderAction>;
  readerActionStatus?: string | null;
  readerPaymentIntentMatches: boolean;
  readerFailureCode?: string | null;
  attemptStatus: PaymentAttempt["status"];
}) {
  if (input.paymentIntentStatus === "succeeded") {
    return input.amountReceived === input.expectedAmountCents ? "SUCCEEDED" as const : "UNCERTAIN" as const;
  }
  if (input.paymentIntentStatus === "canceled") return "CANCELED" as const;
  if (input.paymentIntentStatus === "processing") return "PROCESSING" as const;
  if (input.readerPaymentIntentMatches && input.readerActionStatus === "failed") {
    return input.readerFailureCode === "customer_canceled" ? "CANCELED" as const : "FAILED" as const;
  }
  if (input.readerPaymentIntentMatches && input.readerActionStatus === "succeeded") return "UNCERTAIN" as const;
  if (input.readerAction === "PAYMENT_ACTIVE" && input.readerPaymentIntentMatches) {
    if (input.readerActionStatus === "in_progress") {
      return "WAITING" as const;
    }
  }
  if (input.paymentIntentStatus === "requires_payment_method" && input.readerAction === "IDLE" &&
      ["SENT_TO_READER", "WAITING_FOR_CUSTOMER", "PROCESSING"].includes(input.attemptStatus)) {
    return "FAILED" as const;
  }
  if (input.paymentIntentStatus === "requires_payment_method" && input.readerAction === "IDLE" &&
      input.attemptStatus === "PAYMENT_INTENT_CREATED") {
    return "READY" as const;
  }
  return "UNCERTAIN" as const;
}

export function shouldRecoverExpiredIdleReservation(input: {
  lockExpiresAt: Date | null;
  now: Date;
  readerAction: ReturnType<typeof classifyReaderAction>;
  attemptStatus: PaymentAttempt["status"];
  hasPaymentIntent: boolean;
  hasReaderOperation: boolean;
}) {
  return Boolean(
    input.lockExpiresAt && input.lockExpiresAt.getTime() <= input.now.getTime() &&
    input.readerAction === "IDLE" && input.attemptStatus === "READER_RESERVED" &&
    !input.hasPaymentIntent && !input.hasReaderOperation,
  );
}

async function recoverExpiredIdleReservation(input: {
  db: Database;
  env: WorkerBindings;
  stripe?: StripeTerminalClient;
  lockedPaymentAttemptId: string | null;
  lockExpiresAt: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!input.lockedPaymentAttemptId || !input.lockExpiresAt || input.lockExpiresAt.getTime() > now.getTime()) return false;
  const [locked] = await input.db.select({
    attemptStatus: paymentAttempts.status,
    transactionId: paymentAttempts.transactionId,
    stripePaymentIntentId: paymentAttempts.stripePaymentIntentId,
    stripeReaderOperationId: paymentAttempts.stripeReaderOperationId,
  }).from(paymentAttempts).where(eq(paymentAttempts.id, input.lockedPaymentAttemptId)).limit(1);
  if (!locked) return false;
  try {
    const stripe = input.stripe ?? createStripeTerminalClient(input.env);
    const reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
    validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    if (!shouldRecoverExpiredIdleReservation({
      lockExpiresAt: input.lockExpiresAt,
      now,
      readerAction: classifyReaderAction(reader),
      attemptStatus: locked.attemptStatus,
      hasPaymentIntent: Boolean(locked.stripePaymentIntentId),
      hasReaderOperation: Boolean(locked.stripeReaderOperationId),
    })) return false;

    return input.db.transaction(async (tx) => {
      const [released] = await tx.update(terminalReaders).set({
        lockPaymentAttemptId: null,
        lockAcquiredAt: null,
        lockExpiresAt: null,
        updatedAt: now,
      }).where(and(
        eq(terminalReaders.lockPaymentAttemptId, input.lockedPaymentAttemptId!),
        lte(terminalReaders.lockExpiresAt, now),
      )).returning({ id: terminalReaders.id });
      if (!released) return false;
      const [expired] = await tx.update(paymentAttempts).set({
        status: "EXPIRED",
        completedAt: now,
        lastErrorCode: "stale_reader_reservation_recovered",
        lastErrorMessage: "Expired database reservation released after Stripe confirmed the reader was idle.",
        updatedAt: now,
      }).where(and(
        eq(paymentAttempts.id, input.lockedPaymentAttemptId!),
        eq(paymentAttempts.status, "READER_RESERVED"),
        isNull(paymentAttempts.stripePaymentIntentId),
        isNull(paymentAttempts.stripeReaderOperationId),
      )).returning({ id: paymentAttempts.id });
      if (!expired) throw new Error("Stale reader reservation changed during recovery.");
      await tx.update(transactions).set({
        paymentStatus: "CANCELED",
        updatedAt: now,
      }).where(and(
        eq(transactions.id, locked.transactionId),
        ne(transactions.paymentStatus, "PAID"),
        isNull(transactions.stripePaymentIntentId),
      ));
      return true;
    });
  } catch (error) {
    console.error("Expired reader reservation was not released", {
      paymentAttemptId: input.lockedPaymentAttemptId,
      message: error instanceof Error ? error.message : "Unknown reservation recovery failure",
    });
    return false;
  }
}

async function claimReaderProcessTransition(input: { db: Database; attemptId: string }) {
  const [claimed] = await input.db.update(paymentAttempts).set({
    status: "SENT_TO_READER",
    lastErrorCode: "READER_PROCESS_STARTING",
    lastErrorMessage: null,
    updatedAt: new Date(),
  }).where(and(
    eq(paymentAttempts.id, input.attemptId),
    inArray(paymentAttempts.status, ["PAYMENT_INTENT_CREATED", "READER_RESERVED"]),
    isNull(paymentAttempts.lastErrorCode),
    isNull(paymentAttempts.stripeReaderOperationId),
    isNotNull(paymentAttempts.stripePaymentIntentId),
  )).returning({ id: paymentAttempts.id });
  return Boolean(claimed);
}

export function shouldReplayUnrecordedReaderProcess(input: {
  attemptStatus: PaymentAttempt["status"];
  lastErrorCode: string | null;
  hasReaderOperation: boolean;
  paymentIntentStatus: string;
  readerAction: ReturnType<typeof classifyReaderAction>;
}) {
  return input.attemptStatus === "SENT_TO_READER" &&
    input.lastErrorCode === "READER_PROCESS_STARTING" &&
    !input.hasReaderOperation &&
    input.paymentIntentStatus === "requires_payment_method" &&
    (input.readerAction === "IDLE" || input.readerAction === "CART_DISPLAY");
}

async function currentPaymentView(db: Database, transactionId: string): Promise<EmployeePaymentView> {
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  if (["PAID", "CANCELED"].includes(transaction.paymentStatus)) {
    const [attempt] = await db.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.transactionId, transactionId)).orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
    if (attempt) await releaseReaderReservation(db, attempt.id);
  }
  return view(transactionId, transaction.paymentStatus);
}

// A Reader response may arrive after a webhook or cancellation. Record identity
// only while the attempt can still advance, and never move PROCESSING backwards.
async function recordReaderOperation(input: {
  db: Database; attemptId: string; transactionId: string; paymentIntentId: string; reader: StripeReader;
}) {
  return input.db.transaction(async tx => {
    const [attempt] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, input.attemptId)).limit(1).for("update");
    const [transaction] = await tx.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1).for("update");
    if (!attempt || !transaction || attempt.stripePaymentIntentId !== input.paymentIntentId || transaction.stripePaymentIntentId !== input.paymentIntentId) {
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status needs reconciliation.", 503);
    }
    if (transaction.paymentStatus === "PAID" || attempt.status === "SUCCEEDED") return view(transaction.id, "PAID");
    if (["CANCELED", "FAILED"].includes(transaction.paymentStatus) || ["CANCELED", "FAILED", "EXPIRED"].includes(attempt.status) || attempt.lastErrorCode === "CANCEL_STARTING") return view(transaction.id, transaction.paymentStatus);
    const location = stripeReaderLocationId(input.reader);
    const operationId = `${input.reader.id}:${input.paymentIntentId}`;
    if (!location || (attempt.stripeReaderOperationId && attempt.stripeReaderOperationId !== operationId) ||
      (transaction.stripeReaderId && transaction.stripeReaderId !== input.reader.id) ||
      (transaction.stripeLocationId && transaction.stripeLocationId !== location)) {
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status needs reconciliation.", 503);
    }
    const processing = attempt.status === "PROCESSING" || transaction.paymentStatus === "PROCESSING";
    await tx.update(paymentAttempts).set({ status: processing ? "PROCESSING" : "WAITING_FOR_CUSTOMER",
      stripeReaderOperationId: operationId, lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() }).where(eq(paymentAttempts.id, attempt.id));
    await tx.update(transactions).set({ paymentStatus: processing ? "PROCESSING" : "WAITING_FOR_CUSTOMER",
      stripeReaderId: input.reader.id, stripeLocationId: location, updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
    return view(transaction.id, processing ? "PROCESSING" : "WAITING_FOR_CUSTOMER");
  });
}

export async function startTerminalPayment(input: {
  db: Database; env: WorkerBindings; transactionId: string; stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  const configurationError = stripeLiveConfigurationError(input.env);
  if (configurationError) throw new TerminalFlowError("TERMINAL_NOT_CONFIGURED", configurationError, 503);
  const [transaction] = await input.db.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  if (["PAID", "CANCELED"].includes(transaction.paymentStatus)) return view(transaction.id, transaction.paymentStatus);
  const items = await input.db.select().from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
  let readerCart: TrustedReaderCart;
  try { readerCart = buildTrustedReaderCart(transaction, items); }
  catch { throw new TerminalFlowError("PAYMENT_DETAILS_INVALID", "Unable to verify payment details.", 409); }
  if (!meetsMinimumPayment(readerCart.totalCents)) throw new TerminalFlowError("MINIMUM_PAYMENT", MINIMUM_PAYMENT_MESSAGE, 400);
  await syncConfiguredReader(input.db, input.env);
  let attempt = await getOrCreatePaymentAttempt(input.db, transaction);
  if (["SUCCEEDED", "CANCELED", "FAILED", "EXPIRED"].includes(attempt.status)) return currentPaymentView(input.db, transaction.id);
  if (attempt.expectedAmountCents !== readerCart.totalCents) throw new TerminalFlowError("AMOUNT_MISMATCH", "Stored payment amount is inconsistent");
  let reservation = await reserveConfiguredReader(input.db, input.env, attempt.id);
  if (reservation.status === "TERMINAL_BUSY") {
    const recovered = await recoverExpiredIdleReservation({ db: input.db, env: input.env, stripe: input.stripe,
      lockedPaymentAttemptId: reservation.lockedPaymentAttemptId, lockExpiresAt: reservation.retryAfter });
    if (recovered) reservation = await reserveConfiguredReader(input.db, input.env, attempt.id);
  }
  if (reservation.status === "TERMINAL_BUSY") throw new TerminalFlowError("DATABASE_READER_RESERVED", "Terminal reserved by another transaction", 409);
  if (reservation.status === "TERMINAL_OFFLINE") throw new TerminalFlowError("TERMINAL_OFFLINE", employeePaymentStatus.TERMINAL_OFFLINE, 503);
  const internalReaderId = reservation.readerId;
  const stripe = input.stripe ?? createStripeTerminalClient(input.env);
  let setupOwned = false;
  if (!attempt.stripePaymentIntentId) {
    const [claimed] = await input.db.update(paymentAttempts).set({ status: "READER_RESERVED", terminalReaderId: internalReaderId,
      lastErrorCode: "SETUP_STARTING", lastErrorMessage: null, updatedAt: new Date() }).where(and(
        eq(paymentAttempts.id, attempt.id), inArray(paymentAttempts.status, ["CREATED", "READER_RESERVED"]),
        isNull(paymentAttempts.stripePaymentIntentId), isNull(paymentAttempts.lastErrorCode),
      )).returning();
    if (!claimed) return currentPaymentView(input.db, transaction.id);
    attempt = claimed;
    setupOwned = true;
    await input.db.update(transactions).set({ paymentStatus: "SENDING_TO_TERMINAL", updatedAt: new Date() }).where(and(
      eq(transactions.id, transaction.id), isNull(transactions.stripePaymentIntentId),
      inArray(transactions.paymentStatus, ["DRAFT", "READY", "SENDING_TO_TERMINAL", "TERMINAL_OFFLINE", "TERMINAL_BUSY"]),
    ));
  }
  try {
    let reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
    validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    if (reader.status !== "online") throw new TerminalFlowError("TERMINAL_OFFLINE", employeePaymentStatus.TERMINAL_OFFLINE, 503);
    let paymentIntent: StripePaymentIntent;
    if (!attempt.stripePaymentIntentId) {
      const action = classifyReaderAction(reader);
      if (action === "CART_DISPLAY") validateReaderDisplayState(reader, readerCart);
      else if (action === "IDLE") reader = await setTrustedReaderDisplay({ stripe, readerId: reader.id,
        locationId: input.env.STRIPE_TERMINAL_LOCATION_ID!, idempotencyKey: attempt.idempotencyKey, cart: readerCart });
      else throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state needs reconciliation.", 503);
      // Own display -> own payment preparation is expected. Polling must not
      // write this state, and Cancel cannot erase an in-flight intent creation.
      const [creating] = await input.db.update(paymentAttempts).set({ lastErrorCode: "INTENT_CREATING", updatedAt: new Date() }).where(and(
        eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, "READER_RESERVED"),
        eq(paymentAttempts.lastErrorCode, "SETUP_STARTING"), isNull(paymentAttempts.stripePaymentIntentId),
      )).returning();
      if (!creating) return currentPaymentView(input.db, transaction.id);
      attempt = creating;
      paymentIntent = await stripe.createPaymentIntent({ amountCents: readerCart.totalCents, idempotencyKey: attempt.idempotencyKey,
        metadata: buildBrickellHousePaymentIntentMetadata({ attemptId: attempt.id, transactionId: transaction.id, transactionNumber: transaction.number }) });
      validateLivePaymentIntent({ paymentIntent, paymentAttemptId: attempt.id, transactionId: transaction.id, transactionNumber: transaction.number, amountCents: readerCart.totalCents });
      await persistPaymentIntentMapping({ db: input.db, attemptId: attempt.id, transactionId: transaction.id, paymentIntentId: paymentIntent.id });
      const [mapped] = await input.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id)).limit(1);
      attempt = mapped;
    } else {
      paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
      validateLivePaymentIntent({ paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
        paymentAttemptId: attempt.id, transactionId: transaction.id, transactionNumber: transaction.number, amountCents: readerCart.totalCents });
      if (paymentIntent.status === "succeeded") {
        await reconcileTerminalPaymentSuccess({ db: input.db, env: input.env, transactionId: transaction.id,
          paymentAttemptId: attempt.id, paymentIntent, authoritativeReader: reader, managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL });
        return view(transaction.id, "PAID");
      }
      if (paymentIntent.status === "processing") return view(transaction.id, "PROCESSING");
      if (classifyReaderAction(reader) === "PAYMENT_ACTIVE" && readerIntentId(reader) === paymentIntent.id) {
        return recordReaderOperation({ db: input.db, attemptId: attempt.id, transactionId: transaction.id, paymentIntentId: paymentIntent.id, reader });
      }
      if (attempt.stripeReaderOperationId || attempt.status === "SENT_TO_READER" || attempt.lastErrorCode) {
        // Do not issue another process command merely because its response was lost.
        return currentPaymentView(input.db, transaction.id);
      }
      if (classifyReaderAction(reader) === "CART_DISPLAY") validateReaderDisplayState(reader, readerCart);
      else if (classifyReaderAction(reader) !== "IDLE") throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state needs reconciliation.", 503);
    }
    if (paymentIntent.status !== "requires_payment_method" || paymentIntent.amount_received !== 0 || paymentIntent.payment_method || paymentIntent.latest_charge) {
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status needs reconciliation.", 503);
    }
    const processClaimed = await claimReaderProcessTransition({ db: input.db, attemptId: attempt.id });
    if (!processClaimed) return currentPaymentView(input.db, transaction.id);
    const processedReader = await processAfterPaymentIntentPersistence({
      confirmPersisted: () => confirmPaymentIntentMapping({ db: input.db, attemptId: attempt.id, transactionId: transaction.id, paymentIntentId: paymentIntent.id }),
      processPaymentIntent: () => stripe.processPaymentIntent({ readerId: input.env.STRIPE_TERMINAL_READER_ID!, paymentIntentId: paymentIntent.id,
        idempotencyKey: buildReaderProcessIdempotencyKey(attempt.idempotencyKey) }),
    });
    validateLiveReader(processedReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    validateReaderPaymentAction(processedReader, paymentIntent.id);
    const result = await recordReaderOperation({ db: input.db, attemptId: attempt.id, transactionId: transaction.id, paymentIntentId: paymentIntent.id, reader: processedReader });
    if (result.paymentStatus !== "PAID" && result.paymentStatus !== "CANCELED") await extendReaderReservation(input.db, internalReaderId, attempt.id);
    return result;
  } catch (error) {
    if (setupOwned) {
      // SETUP_STARTING has not sent intent creation. INTENT_CREATING is left
      // blocked if its result is unknown; timeout cannot prove absence of payment.
      await input.db.update(paymentAttempts).set({ lastErrorCode: "SETUP_FAILED", lastErrorMessage: "Terminal setup could not finish.", updatedAt: new Date() })
        .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.lastErrorCode, "SETUP_STARTING"), isNull(paymentAttempts.stripePaymentIntentId)));
    }
    if (error instanceof TerminalFlowError) throw error;
    throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status needs reconciliation. Select Cancel to check whether it can be canceled.", 503);
  }
}

export function setupPaymentView(transactionId: string, attemptUpdatedAt: Date, now = new Date()): EmployeePaymentView {
  const expired = now.getTime() - attemptUpdatedAt.getTime() >= READER_DISPLAY_TIMEOUT_MS;
  return { ...view(transactionId, "SENDING_TO_TERMINAL"), setupRecoveryRequired: expired,
    displayStatus: expired ? "Terminal setup needs attention. Select Cancel to check whether it can be canceled." : "Preparing terminal" };
}

export async function reconcileTerminalPayment(input: {
  db: Database; env: WorkerBindings; transactionId: string; stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  const configurationError = stripeLiveConfigurationError(input.env);
  if (configurationError) throw new TerminalFlowError("TERMINAL_NOT_CONFIGURED", configurationError, 503);
  const [transaction] = await input.db.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  const [attempt] = await input.db.select().from(paymentAttempts).where(eq(paymentAttempts.transactionId, transaction.id)).orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
  if (!attempt) return view(transaction.id, transaction.paymentStatus);
  if (transaction.paymentStatus === "PAID" || ["CANCELED", "FAILED", "EXPIRED", "SUCCEEDED"].includes(attempt.status)) {
    await releaseReaderReservation(input.db, attempt.id);
    return currentPaymentView(input.db, transaction.id);
  }
  const stripe = input.stripe ?? createStripeTerminalClient(input.env);
  const reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
  validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
  const readerAction = classifyReaderAction(reader);
  const uncertain = () => new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status needs reconciliation. Select Cancel to check whether it can be canceled.", 503);
  const observations = await input.db.select({ status: terminalReaderObservations.actionStatus }).from(terminalReaderObservations)
    .where(eq(terminalReaderObservations.paymentAttemptId, attempt.id));
  const [reservation] = await input.db.select().from(terminalReaders).where(eq(terminalReaders.stripeReaderId, input.env.STRIPE_TERMINAL_READER_ID!)).limit(1);
  if (!attempt.stripePaymentIntentId) {
    // No polling write is permitted in setup. This read may predate our own
    // display, intent persistence, or process response. Never overwrite them.
    if (observations.length || (readerAction !== "IDLE" && readerAction !== "CART_DISPLAY")) throw uncertain();
    if (readerAction === "CART_DISPLAY") {
      const items = await input.db.select().from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
      try { validateReaderDisplayState(reader, buildTrustedReaderCart(transaction, items)); } catch { throw uncertain(); }
    }
    const [latest] = await input.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id)).limit(1);
    if (!latest || latest.status !== attempt.status || latest.stripePaymentIntentId !== attempt.stripePaymentIntentId || latest.lastErrorCode !== attempt.lastErrorCode) return currentPaymentView(input.db, transaction.id);
    return setupPaymentView(transaction.id, attempt.updatedAt);
  }
  const paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
  validateLivePaymentIntent({ paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId, paymentAttemptId: attempt.id,
    transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents });
  if (paymentIntent.status === "succeeded") {
    await reconcileTerminalPaymentSuccess({ db: input.db, env: input.env, transactionId: transaction.id, paymentAttemptId: attempt.id,
      paymentIntent, authoritativeReader: reader, managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL });
    return view(transaction.id, "PAID");
  }
  if (observations.some(o => o.status === "succeeded") || (readerIntentId(reader) === paymentIntent.id && reader.action?.status === "succeeded")) throw uncertain();
  if (attempt.lastErrorCode === "CANCEL_STARTING") return { ...view(transaction.id, transaction.paymentStatus), displayStatus: "Checking cancellation. Do not start another charge." };
  if (reservation?.lockPaymentAttemptId !== attempt.id || reader.status !== "online") throw uncertain();
  if (readerAction === "PAYMENT_ACTIVE" && readerIntentId(reader) !== paymentIntent.id) throw uncertain();
  if (paymentIntent.status === "processing") {
    await input.db.transaction(async tx => {
      const [advanced] = await tx.update(paymentAttempts).set({ status: "PROCESSING", updatedAt: new Date() }).where(and(
        eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, attempt.status), eq(paymentAttempts.updatedAt, attempt.updatedAt),
        inArray(paymentAttempts.status, ["READER_RESERVED", "PAYMENT_INTENT_CREATED", "SENT_TO_READER", "WAITING_FOR_CUSTOMER", "PROCESSING"]),
        or(isNull(paymentAttempts.lastErrorCode), ne(paymentAttempts.lastErrorCode, "CANCEL_STARTING")),
      )).returning({ id: paymentAttempts.id });
      if (!advanced) return;
      await tx.update(transactions).set({ paymentStatus: "PROCESSING", updatedAt: new Date() }).where(and(eq(transactions.id, transaction.id),
        inArray(transactions.paymentStatus, ["DRAFT", "READY", "SENDING_TO_TERMINAL", "WAITING_FOR_CUSTOMER", "PROCESSING"])));
    });
    return currentPaymentView(input.db, transaction.id);
  }
  if (readerAction === "PAYMENT_ACTIVE" && readerIntentId(reader) === paymentIntent.id) {
    return recordReaderOperation({ db: input.db, attemptId: attempt.id, transactionId: transaction.id, paymentIntentId: paymentIntent.id, reader });
  }
  if (readerAction === "IDLE" && paymentIntent.status === "canceled" && !paymentIntent.latest_charge && paymentIntent.amount_received === 0) {
    await markPaymentFailed({ db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id, expectedPaymentIntentId: paymentIntent.id,
      canceled: true, code: "stripe_canceled", message: "Stripe confirmed cancellation." });
    return currentPaymentView(input.db, transaction.id);
  }
  if (paymentIntent.status === "requires_payment_method" && !paymentIntent.latest_charge && !paymentIntent.payment_method && paymentIntent.amount_received === 0 &&
    !attempt.stripeReaderOperationId && ["READER_RESERVED", "PAYMENT_INTENT_CREATED", "SENT_TO_READER"].includes(attempt.status) &&
    (readerAction === "IDLE" || readerAction === "CART_DISPLAY")) {
    if (readerAction === "CART_DISPLAY") {
      const items = await input.db.select().from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
      try { validateReaderDisplayState(reader, buildTrustedReaderCart(transaction, items)); } catch { throw uncertain(); }
    }
    return setupPaymentView(transaction.id, attempt.updatedAt);
  }
  // A cleared/changed Reader action alone is never evidence that payment failed.
  throw uncertain();
}

export async function reconcileOpenTerminalPayments(input: {
  env: WorkerBindings;
  db?: Database;
  stripe?: StripeTerminalClient;
  now?: Date;
}): Promise<{ reconciled: number; deferred: number }> {
  const db = input.db ?? createDatabase(input.env);
  if (!db || stripeLiveConfigurationError(input.env)) return { reconciled: 0, deferred: 0 };
  const orphanCutoff = new Date((input.now ?? new Date()).getTime() - READER_DISPLAY_TIMEOUT_MS);
  const candidates = await db.select({ transactionId: paymentAttempts.transactionId }).from(paymentAttempts)
    .innerJoin(transactions, eq(transactions.id, paymentAttempts.transactionId))
    .where(or(
      and(
        inArray(paymentAttempts.status, ["PAYMENT_INTENT_CREATED", "SENT_TO_READER", "WAITING_FOR_CUSTOMER", "PROCESSING"]),
        isNotNull(paymentAttempts.stripePaymentIntentId),
      ),
      and(
        eq(paymentAttempts.status, "READER_RESERVED"),
        isNull(paymentAttempts.stripePaymentIntentId),
        ne(transactions.paymentStatus, "SENDING_TO_TERMINAL"),
        lte(paymentAttempts.updatedAt, orphanCutoff),
      ),
    )).limit(10);
  const stripe = input.stripe ?? createStripeTerminalClient(input.env);
  let reconciled = 0;
  let deferred = 0;
  for (const candidate of candidates) {
    try {
      const result = await reconcileTerminalPayment({ db, env: input.env, stripe, transactionId: candidate.transactionId });
      if (["PAID", "FAILED", "CANCELED"].includes(result.paymentStatus)) reconciled += 1;
    } catch (error) {
      deferred += 1;
      console.error("Open terminal payment remains protected during reconciliation", {
        transactionId: candidate.transactionId,
        message: error instanceof Error ? error.message : "Unknown payment reconciliation failure",
      });
    }
  }
  return { reconciled, deferred };
}

export async function cancelTerminalPayment(input: {
  db: Database; env: WorkerBindings; transactionId: string; stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  const configurationError = stripeLiveConfigurationError(input.env);
  if (configurationError) throw new TerminalFlowError("TERMINAL_NOT_CONFIGURED", configurationError, 503);
  const [transaction] = await input.db.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  if (["PAID", "CANCELED"].includes(transaction.paymentStatus)) return view(transaction.id, transaction.paymentStatus);
  const attempt = await getOrCreatePaymentAttempt(input.db, transaction);
  const uncertain = () => new TerminalFlowError("TERMINAL_UNCERTAIN", "This payment cannot yet be safely canceled. Reconciliation is required.", 503);
  if (attempt.status === "SUCCEEDED" || attempt.expectedAmountCents !== transaction.totalCents || transaction.stripePaymentIntentId !== attempt.stripePaymentIntentId ||
    transaction.stripeChargeId || transaction.paidAt) throw uncertain();
  const stripe = input.stripe ?? createStripeTerminalClient(input.env);
  let reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
  validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
  let paymentIntent = attempt.stripePaymentIntentId ? await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId) : null;
  const validateIntent = (intent: StripePaymentIntent) => validateLivePaymentIntent({ paymentIntent: intent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
    paymentAttemptId: attempt.id, transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents });
  if (paymentIntent) validateIntent(paymentIntent);
  if (paymentIntent?.status === "succeeded") {
    await reconcileTerminalPaymentSuccess({ db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
      env: input.env, paymentIntent, authoritativeReader: reader, managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL });
    return view(transaction.id, "PAID");
  }
  const observations = await input.db.select({ status: terminalReaderObservations.actionStatus }).from(terminalReaderObservations).where(eq(terminalReaderObservations.paymentAttemptId, attempt.id));
  if (observations.some(o => o.status === "succeeded") || (readerIntentId(reader) === attempt.stripePaymentIntentId && reader.action?.status === "succeeded")) throw uncertain();
  if (!paymentIntent && (attempt.stripeReaderOperationId || observations.length || !["CREATED", "READER_RESERVED"].includes(attempt.status) ||
    (attempt.lastErrorCode && !["SETUP_FAILED", "CANCEL_STARTING"].includes(attempt.lastErrorCode)))) throw uncertain();
  if (paymentIntent && (!["requires_payment_method", "canceled"].includes(paymentIntent.status) ||
    paymentIntent.payment_method !== null || paymentIntent.latest_charge !== null || paymentIntent.amount_received !== 0)) throw uncertain();
  const [reservation] = await input.db.select().from(terminalReaders).where(eq(terminalReaders.stripeReaderId, input.env.STRIPE_TERMINAL_READER_ID!)).limit(1);
  const ownsReader = reservation?.lockPaymentAttemptId === attempt.id && reservation.active && reservation.stripeLocationId === input.env.STRIPE_TERMINAL_LOCATION_ID;
  // A draft that never reserved the Reader can be abandoned locally, even if
  // another employee is using the terminal. It has no permission to clear it.
  const localDraft = !paymentIntent && attempt.status === "CREATED" && !attempt.lastErrorCode && !attempt.terminalReaderId;
  if (!localDraft && (!ownsReader || reader.status !== "online")) throw uncertain();
  const items = await input.db.select().from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
  const cart = buildTrustedReaderCart(transaction, items);
  const validateCancelableReader = (value: StripeReader) => {
    const action = classifyReaderAction(value);
    if (action === "CART_DISPLAY") validateReaderDisplayState(value, cart);
    else if (action === "PAYMENT_ACTIVE") {
      if (!paymentIntent || readerIntentId(value) !== paymentIntent.id) throw uncertain();
    } else if (action !== "IDLE") throw uncertain();
  };
  if (!localDraft) validateCancelableReader(reader);
  const [claimed] = await input.db.update(paymentAttempts).set({ lastErrorCode: "CANCEL_STARTING", updatedAt: new Date() }).where(and(
    eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, attempt.status), eq(paymentAttempts.updatedAt, attempt.updatedAt),
    attempt.stripePaymentIntentId ? eq(paymentAttempts.stripePaymentIntentId, attempt.stripePaymentIntentId) : isNull(paymentAttempts.stripePaymentIntentId),
    attempt.lastErrorCode ? eq(paymentAttempts.lastErrorCode, attempt.lastErrorCode) : isNull(paymentAttempts.lastErrorCode),
  )).returning({ id: paymentAttempts.id });
  if (!claimed) {
    const current = await currentPaymentView(input.db, transaction.id);
    return ["PAID", "CANCELED"].includes(current.paymentStatus) ? current : {
      ...current, displayStatus: "Payment state changed during the check. Select Cancel again to recheck.",
    };
  }
  if (paymentIntent && paymentIntent.status !== "canceled") {
    try {
      paymentIntent = await stripe.cancelPaymentIntent({ paymentIntentId: paymentIntent.id, idempotencyKey: `${attempt.idempotencyKey}:cancel-intent` });
    } catch {
      // The cancellation response can be lost or Stripe can have completed the
      // payment first. Retrieve its outcome; never infer cancellation from error.
      paymentIntent = await stripe.retrievePaymentIntent(paymentIntent.id);
    }
    validateIntent(paymentIntent);
    if (paymentIntent.status === "succeeded") {
      await reconcileTerminalPaymentSuccess({ db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
        env: input.env, paymentIntent, authoritativeReader: reader, managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL });
      return view(transaction.id, "PAID");
    }
    if (paymentIntent.status !== "canceled" || paymentIntent.amount_received !== 0 || paymentIntent.latest_charge || paymentIntent.payment_method) throw uncertain();
  }
  if (!localDraft) {
    reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
    validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    if (reader.status !== "online") throw uncertain();
    validateCancelableReader(reader);
    // Clear only after definitive PI cancellation (or proof creation never began).
    if (classifyReaderAction(reader) !== "IDLE") {
      reader = await stripe.cancelReaderAction({ readerId: reader.id, idempotencyKey: `${attempt.idempotencyKey}:cancel-display-after-intent` });
      validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
      if (classifyReaderAction(reader) !== "IDLE") throw uncertain();
    }
  }
  const canceled = await markPaymentFailed({ db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
    expectedPaymentIntentId: attempt.stripePaymentIntentId, code: "employee_canceled", message: "Payment canceled after Stripe reconciliation.", canceled: true });
  return canceled ? view(transaction.id, "CANCELED") : currentPaymentView(input.db, transaction.id);
}

// Legacy clients and the display watchdog use the same state-aware cancellation.
export async function clearTerminalDisplay(input: {
  db: Database; env: WorkerBindings; transactionId: string; reason?: "employee_abandoned" | "display_timeout"; stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  return cancelTerminalPayment(input);
}

export async function expireAbandonedReaderDisplays(input: {
  env: WorkerBindings;
  db?: Database;
  stripe?: StripeTerminalClient;
  now?: Date;
}): Promise<{ expired: number; deferred: number }> {
  const db = input.db ?? createDatabase(input.env);
  if (!db || stripeLiveConfigurationError(input.env)) return { expired: 0, deferred: 0 };
  const cutoff = new Date((input.now ?? new Date()).getTime() - READER_DISPLAY_TIMEOUT_MS);
  const candidates = await db.select({ transactionId: transactions.id }).from(paymentAttempts)
    .innerJoin(transactions, eq(transactions.id, paymentAttempts.transactionId))
    .where(and(
      eq(paymentAttempts.status, "READER_RESERVED"),
      isNull(paymentAttempts.stripePaymentIntentId),
      isNull(paymentAttempts.lastErrorCode),
      eq(transactions.paymentStatus, "SENDING_TO_TERMINAL"),
      isNull(transactions.stripePaymentIntentId),
      lte(paymentAttempts.updatedAt, cutoff),
    )).limit(10);
  let expired = 0;
  let deferred = 0;
  const stripe = input.stripe ?? createStripeTerminalClient(input.env);
  for (const candidate of candidates) {
    try {
      await clearTerminalDisplay({
        db, env: input.env, stripe,
        transactionId: candidate.transactionId,
        reason: "display_timeout",
      });
      expired += 1;
    } catch (error) {
      deferred += 1;
      console.error("Abandoned reader display was left untouched after reconciliation", {
        transactionId: candidate.transactionId,
        message: error instanceof Error ? error.message : "Unknown display reconciliation failure",
      });
    }
  }
  return { expired, deferred };
}
