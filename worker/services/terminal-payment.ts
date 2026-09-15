import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { createDatabase, type Database } from "@/db/client";
import { paymentAttempts, terminalReaders, transactionItems, transactions } from "@/db/schema";
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
  buildBrickellHousePaymentIntentMetadata, createStripeTerminalClient, StripeApiError, stripeLiveConfigurationError,
  stripeReaderLocationId, validateLivePaymentIntent, validateLiveReader, validateReaderDisplayState, validateReaderPaymentAction,
} from "@worker/services/stripe-client";
import type { StripeReaderCart, StripeTerminalClient } from "@worker/services/stripe-client";
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
      or(isNull(paymentAttempts.stripePaymentIntentId), eq(paymentAttempts.stripePaymentIntentId, input.paymentIntentId)),
    )).returning({ id: paymentAttempts.id });
    if (!attempt) throw new Error("PaymentIntent could not be attached to its payment attempt.");

    const [transaction] = await tx.update(transactions).set({
      stripePaymentIntentId: input.paymentIntentId,
      paymentStatus: "READY",
      updatedAt: now,
    }).where(and(
      eq(transactions.id, input.transactionId),
      ne(transactions.paymentStatus, "PAID"),
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

async function claimDisplayedCartTransition(input: {
  db: Database;
  attemptId: string;
  marker: "DISPLAY_CLEARING";
}) {
  const [claimed] = await input.db.update(paymentAttempts).set({
    lastErrorCode: input.marker,
    lastErrorMessage: null,
    updatedAt: new Date(),
  }).where(and(
    eq(paymentAttempts.id, input.attemptId),
    eq(paymentAttempts.status, "READER_RESERVED"),
    isNull(paymentAttempts.stripePaymentIntentId),
    isNull(paymentAttempts.lastErrorCode),
  )).returning({ id: paymentAttempts.id });
  return Boolean(claimed);
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
    or(
      and(eq(paymentAttempts.status, "PAYMENT_INTENT_CREATED"), isNull(paymentAttempts.lastErrorCode)),
      eq(paymentAttempts.status, "FAILED"),
    ),
    isNull(paymentAttempts.stripeReaderOperationId),
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

export async function startTerminalPayment(input: {
  db: Database;
  env: WorkerBindings;
  transactionId: string;
  stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  const configurationError = stripeLiveConfigurationError(input.env);
  if (configurationError) throw new TerminalFlowError("TERMINAL_NOT_CONFIGURED", configurationError, 503);
  const [transaction] = await input.db.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  if (transaction.paymentStatus === "PAID") return view(transaction.id, "PAID");

  const itemSnapshots = await input.db.select({
    productId: transactionItems.productId,
    productNameSnapshot: transactionItems.productNameSnapshot,
    unitPriceCentsSnapshot: transactionItems.unitPriceCentsSnapshot,
    quantity: transactionItems.quantity,
    lineTotalCents: transactionItems.lineTotalCents,
  }).from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
  let readerCart: TrustedReaderCart;
  try {
    readerCart = buildTrustedReaderCart(transaction, itemSnapshots);
  } catch (error) {
    console.error("Trusted reader cart validation failed", {
      transactionId: transaction.id,
      message: error instanceof Error ? error.message : "Unknown cart validation failure",
    });
    throw new TerminalFlowError("PAYMENT_DETAILS_INVALID", "Unable to start payment", 409);
  }
  const paymentAmountCents = readerCart.totalCents;
  if (!meetsMinimumPayment(paymentAmountCents)) {
    throw new TerminalFlowError("MINIMUM_PAYMENT", MINIMUM_PAYMENT_MESSAGE, 400);
  }

  await syncConfiguredReader(input.db, input.env);
  let attempt = await getOrCreatePaymentAttempt(input.db, transaction);
  if (attempt.expectedAmountCents !== paymentAmountCents) throw new TerminalFlowError("AMOUNT_MISMATCH", "Stored payment amount is inconsistent");

  let reservation = await reserveConfiguredReader(input.db, input.env, attempt.id);
  if (reservation.status === "TERMINAL_OFFLINE") {
    await input.db.update(transactions).set({ paymentStatus: "TERMINAL_OFFLINE", updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
    throw new TerminalFlowError("TERMINAL_OFFLINE", employeePaymentStatus.TERMINAL_OFFLINE, 503);
  }
  if (reservation.status === "TERMINAL_BUSY") {
    const recovered = await recoverExpiredIdleReservation({
      db: input.db,
      env: input.env,
      stripe: input.stripe,
      lockedPaymentAttemptId: reservation.lockedPaymentAttemptId,
      lockExpiresAt: reservation.retryAfter,
    });
    if (recovered) reservation = await reserveConfiguredReader(input.db, input.env, attempt.id);
    if (reservation.status === "TERMINAL_BUSY") {
      await input.db.update(transactions).set({ paymentStatus: "TERMINAL_BUSY", updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
      throw new TerminalFlowError("DATABASE_READER_RESERVED", "Terminal reserved by another transaction", 409);
    }
    if (reservation.status === "TERMINAL_OFFLINE") {
      throw new TerminalFlowError("TERMINAL_OFFLINE", employeePaymentStatus.TERMINAL_OFFLINE, 503);
    }
  }
  const internalReaderId = reservation.readerId;
  if (!attempt.stripePaymentIntentId) {
    await input.db.update(paymentAttempts).set({
      status: "READER_RESERVED",
      terminalReaderId: internalReaderId,
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: null,
      updatedAt: new Date(),
    })
      .where(eq(paymentAttempts.id, attempt.id));
  }

  let stripe: StripeTerminalClient;
  let stripeReader: Awaited<ReturnType<StripeTerminalClient["retrieveReader"]>>;
  try {
    stripe = input.stripe ?? createStripeTerminalClient(input.env);
    stripeReader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
    validateLiveReader(stripeReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
  } catch (error) {
    const stripeError = error instanceof StripeApiError ? error : null;
    console.error("Terminal payment reader preflight failed", {
      stage: "retrieve_reader",
      transactionId: transaction.id,
      paymentAttemptId: attempt.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
      stripeCode: stripeError?.code,
      stripeStatus: stripeError?.status,
      message: error instanceof Error ? error.message : "Unknown reader preflight failure",
    });
    await input.db.update(paymentAttempts).set({
      status: "CREATED",
      lastErrorCode: stripeError?.code ?? "READER_PREFLIGHT_FAILED",
      lastErrorMessage: "Terminal availability could not be verified.",
      updatedAt: new Date(),
    }).where(eq(paymentAttempts.id, attempt.id));
    await input.db.update(transactions).set({ paymentStatus: "TERMINAL_OFFLINE", updatedAt: new Date() })
      .where(eq(transactions.id, transaction.id));
    await releaseReaderReservation(input.db, attempt.id);
    throw new TerminalFlowError("TERMINAL_UNAVAILABLE", "Unable to start payment", 503);
  }
  if (stripeReader.status === "offline") {
    await input.db.update(transactions).set({ paymentStatus: "TERMINAL_OFFLINE", updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
    await releaseReaderReservation(input.db, attempt.id);
    throw new TerminalFlowError("TERMINAL_OFFLINE", employeePaymentStatus.TERMINAL_OFFLINE, 503);
  }

  if (!attempt.stripePaymentIntentId) {
    try {
      const existingReaderAction = classifyReaderAction(stripeReader);
      if (existingReaderAction === "CART_DISPLAY") {
        try {
          validateReaderDisplayState(stripeReader, readerCart);
        } catch {
          await input.db.update(paymentAttempts).set({ status: "CREATED", updatedAt: new Date() })
            .where(and(eq(paymentAttempts.id, attempt.id), isNull(paymentAttempts.stripePaymentIntentId)));
          throw new TerminalFlowError("TERMINAL_CART_ACTIVE", "A different terminal cart is already active", 409);
        }
      }
      else if (existingReaderAction === "PAYMENT_ACTIVE") {
        await input.db.update(paymentAttempts).set({ status: "CREATED", updatedAt: new Date() })
          .where(and(eq(paymentAttempts.id, attempt.id), isNull(paymentAttempts.stripePaymentIntentId)));
        throw new TerminalFlowError("PAYMENT_ACTIVE", "Payment in progress—do not retry", 409);
      }
      else if (existingReaderAction !== "IDLE") {
        await input.db.update(paymentAttempts).set({ status: "CREATED", updatedAt: new Date() })
          .where(and(eq(paymentAttempts.id, attempt.id), isNull(paymentAttempts.stripePaymentIntentId)));
        throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state is being reconciled—do not retry", 503);
      }
      if (existingReaderAction === "IDLE") {
        stripeReader = await setTrustedReaderDisplay({
          stripe,
          readerId: input.env.STRIPE_TERMINAL_READER_ID!,
          locationId: input.env.STRIPE_TERMINAL_LOCATION_ID!,
          idempotencyKey: attempt.idempotencyKey,
          cart: readerCart,
        });
      }
      const now = new Date();
      const [displayRecorded] = await input.db.update(paymentAttempts).set({
        status: "READER_RESERVED", terminalReaderId: internalReaderId,
        lastErrorCode: null, lastErrorMessage: null, updatedAt: now,
      }).where(and(
        eq(paymentAttempts.id, attempt.id),
        eq(paymentAttempts.status, "READER_RESERVED"),
        isNull(paymentAttempts.stripePaymentIntentId),
        isNull(paymentAttempts.lastErrorCode),
      )).returning({ id: paymentAttempts.id });
      if (!displayRecorded) {
        const [concurrentAttempt] = await input.db.select().from(paymentAttempts)
          .where(eq(paymentAttempts.id, attempt.id)).limit(1);
        if (!concurrentAttempt?.stripePaymentIntentId) {
          throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state changed during setup—do not retry", 503);
        }
        attempt = concurrentAttempt;
      } else {
        attempt = {
          ...attempt,
          status: "READER_RESERVED",
          terminalReaderId: internalReaderId,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        };
      }
      await input.db.update(transactions).set({ paymentStatus: "SENDING_TO_TERMINAL", updatedAt: now })
        .where(and(
          eq(transactions.id, transaction.id),
          ne(transactions.paymentStatus, "PAID"),
          isNull(transactions.stripePaymentIntentId),
        ));
      await extendReaderReservation(input.db, internalReaderId, attempt.id);
    } catch (error) {
      if (error instanceof TerminalFlowError) {
        await releaseReaderReservation(input.db, attempt.id);
        throw error;
      }
      const stripeError = error instanceof StripeApiError ? error : null;
      console.error("Terminal reader cart display failed", {
        stage: "set_reader_display",
        transactionId: transaction.id,
        paymentAttemptId: attempt.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
        stripeCode: stripeError?.code,
        stripeStatus: stripeError?.status,
        message: error instanceof Error ? error.message : "Unknown reader display failure",
      });
      await input.db.update(paymentAttempts).set({
        status: attempt.stripePaymentIntentId ? "PAYMENT_INTENT_CREATED" : "CREATED",
        lastErrorCode: stripeError?.code ?? "READER_DISPLAY_FAILED",
        lastErrorMessage: "Terminal could not display the trusted payment details.",
        updatedAt: new Date(),
      }).where(eq(paymentAttempts.id, attempt.id));
      await input.db.update(transactions).set({
        paymentStatus: attempt.stripePaymentIntentId ? "READY" : "DRAFT",
        updatedAt: new Date(),
      }).where(eq(transactions.id, transaction.id));
      await releaseReaderReservation(input.db, attempt.id);
      throw new TerminalFlowError("TERMINAL_DISPLAY_UNAVAILABLE", "Unable to display payment details", 503);
    }
  }

  let paymentIntent;
  if (attempt.stripePaymentIntentId) {
    paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
    validateLivePaymentIntent({
      paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
      paymentAttemptId: attempt.id,
      transactionId: transaction.id, transactionNumber: transaction.number, amountCents: paymentAmountCents,
    });
    const action = decideExistingPaymentIntentAction({
      attemptStatus: attempt.status,
      paymentIntentStatus: paymentIntent.status,
      readerAction: classifyReaderAction(stripeReader),
      readerPaymentIntentMatches: readerIntentId(stripeReader) === paymentIntent.id,
      hasReaderOperation: Boolean(attempt.stripeReaderOperationId),
    });
    if (action === "RECONCILE_SUCCESS") {
      await reconcileTerminalPaymentSuccess({
        db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
        env: input.env, paymentIntent, authoritativeReader: stripeReader,
        managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL,
      });
      return view(transaction.id, "PAID");
    }
    if (action === "SHOW_PROCESSING" || action === "SHOW_WAITING") {
      await extendReaderReservation(input.db, internalReaderId, attempt.id);
      return view(transaction.id, action === "SHOW_PROCESSING" ? "PROCESSING" : "WAITING_FOR_CUSTOMER");
    }
    if (action === "SHOW_FAILED") return view(transaction.id, "FAILED");
    if (action === "REFUSE_UNCERTAIN") {
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status is being checked. Do not start another charge.", 503);
    }
  } else {
    paymentIntent = await stripe.createPaymentIntent({
      amountCents: paymentAmountCents,
      idempotencyKey: attempt.idempotencyKey,
      metadata: buildBrickellHousePaymentIntentMetadata({
        attemptId: attempt.id,
        transactionId: transaction.id,
        transactionNumber: transaction.number,
      }),
    });
    validateLivePaymentIntent({
      paymentIntent, paymentAttemptId: attempt.id, transactionId: transaction.id,
      transactionNumber: transaction.number, amountCents: paymentAmountCents,
    });
    await persistPaymentIntentMapping({
      db: input.db,
      attemptId: attempt.id,
      transactionId: transaction.id,
      paymentIntentId: paymentIntent.id,
    });
    attempt = { ...attempt, stripePaymentIntentId: paymentIntent.id, status: "PAYMENT_INTENT_CREATED" };
  }

  const processClaimed = await claimReaderProcessTransition({ db: input.db, attemptId: attempt.id });
  if (!processClaimed) {
    const [currentAttempt] = await input.db.select().from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id)).limit(1);
    const currentReader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
    validateLiveReader(currentReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    if (classifyReaderAction(currentReader) === "PAYMENT_ACTIVE" && readerIntentId(currentReader) === paymentIntent.id) {
      await extendReaderReservation(input.db, internalReaderId, attempt.id);
      return view(transaction.id, "WAITING_FOR_CUSTOMER");
    }
    if (!currentAttempt || currentAttempt.stripePaymentIntentId !== paymentIntent.id ||
        !shouldReplayUnrecordedReaderProcess({
          attemptStatus: currentAttempt.status,
          lastErrorCode: currentAttempt.lastErrorCode,
          hasReaderOperation: Boolean(currentAttempt.stripeReaderOperationId),
          paymentIntentStatus: paymentIntent.status,
          readerAction: classifyReaderAction(currentReader),
        })) {
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status is being checked. Do not start another charge.", 503);
    }
    attempt = currentAttempt;
  }
  attempt = { ...attempt, status: "SENT_TO_READER", lastErrorCode: "READER_PROCESS_STARTING" };

  try {
    const processedReader = await processAfterPaymentIntentPersistence({
      confirmPersisted: () => confirmPaymentIntentMapping({
        db: input.db,
        attemptId: attempt.id,
        transactionId: transaction.id,
        paymentIntentId: paymentIntent.id,
      }),
      processPaymentIntent: () => stripe.processPaymentIntent({
        readerId: input.env.STRIPE_TERMINAL_READER_ID!,
        paymentIntentId: paymentIntent.id,
        idempotencyKey: buildReaderProcessIdempotencyKey(attempt.idempotencyKey),
      }),
    });
    validateLiveReader(processedReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    validateReaderPaymentAction(processedReader, paymentIntent.id);
    const actualLocationId = stripeReaderLocationId(processedReader);
    if (!actualLocationId) throw new Error("Stripe reader response has no authoritative location.");
    const readerOperationId = `${processedReader.id}:${paymentIntent.id}`;
    await input.db.transaction(async (tx) => {
      const [operationRecorded] = await tx.update(paymentAttempts).set({
        status: "WAITING_FOR_CUSTOMER", stripeReaderOperationId: readerOperationId, updatedAt: new Date(),
        lastErrorCode: null, lastErrorMessage: null,
      }).where(and(
        eq(paymentAttempts.id, attempt.id),
        eq(paymentAttempts.stripePaymentIntentId, paymentIntent.id),
        or(isNull(paymentAttempts.stripeReaderOperationId), eq(paymentAttempts.stripeReaderOperationId, readerOperationId)),
      )).returning({ id: paymentAttempts.id });
      if (!operationRecorded) throw new Error("Stripe reader operation evidence could not be persisted.");
      const [readerRecorded] = await tx.update(transactions).set({
        paymentStatus: "WAITING_FOR_CUSTOMER", stripeReaderId: processedReader.id,
        stripeLocationId: actualLocationId, updatedAt: new Date(),
      }).where(and(
        eq(transactions.id, transaction.id),
        eq(transactions.stripePaymentIntentId, paymentIntent.id),
        ne(transactions.paymentStatus, "PAID"),
        or(isNull(transactions.stripeReaderId), eq(transactions.stripeReaderId, processedReader.id)),
        or(isNull(transactions.stripeLocationId), eq(transactions.stripeLocationId, actualLocationId)),
      )).returning({ id: transactions.id });
      if (!readerRecorded) throw new Error("Stripe reader identity evidence could not be persisted.");
    });
    await extendReaderReservation(input.db, internalReaderId, attempt.id);
    return view(transaction.id, "WAITING_FOR_CUSTOMER");
  } catch (error) {
    if (error instanceof StripeApiError && error.code.includes("busy")) {
      await input.db.update(transactions).set({ paymentStatus: "TERMINAL_BUSY", updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
      await releaseReaderReservation(input.db, attempt.id);
      throw new TerminalFlowError("TERMINAL_BUSY", employeePaymentStatus.TERMINAL_BUSY, 409);
    }
    if (error instanceof StripeApiError && error.status >= 500) {
      await input.db.update(paymentAttempts).set({ lastErrorCode: "STRIPE_UNCERTAIN", lastErrorMessage: "Reader state requires reconciliation.", updatedAt: new Date() })
        .where(eq(paymentAttempts.id, attempt.id));
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status is being checked. Do not start another charge.", 503);
    }
    if (!(error instanceof TerminalFlowError)) {
      await input.db.update(paymentAttempts).set({ lastErrorCode: "STRIPE_UNCERTAIN", lastErrorMessage: "Reader state requires reconciliation.", updatedAt: new Date() })
        .where(eq(paymentAttempts.id, attempt.id));
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status is being checked. Do not start another charge.", 503);
    }
    throw error;
  }
}

export async function reconcileTerminalPayment(input: {
  db: Database;
  env: WorkerBindings;
  transactionId: string;
  stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  const configurationError = stripeLiveConfigurationError(input.env);
  if (configurationError) throw new TerminalFlowError("TERMINAL_NOT_CONFIGURED", configurationError, 503);
  const [transaction] = await input.db.select().from(transactions)
    .where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  const [attempt] = await input.db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.transactionId, transaction.id)).orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
  if (!attempt) return view(transaction.id, transaction.paymentStatus);

  if (transaction.paymentStatus === "PAID" || attempt.status === "SUCCEEDED") {
    await releaseReaderReservation(input.db, attempt.id);
    return view(transaction.id, "PAID");
  }
  if (["CANCELED", "FAILED", "EXPIRED"].includes(attempt.status)) {
    await releaseReaderReservation(input.db, attempt.id);
    return view(transaction.id, transaction.paymentStatus);
  }

  const stripe = input.stripe ?? createStripeTerminalClient(input.env);
  const reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
  validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
  const readerAction = classifyReaderAction(reader);

  if (!attempt.stripePaymentIntentId) {
    if (readerAction === "CART_DISPLAY") {
      const itemSnapshots = await input.db.select({
        productId: transactionItems.productId,
        productNameSnapshot: transactionItems.productNameSnapshot,
        unitPriceCentsSnapshot: transactionItems.unitPriceCentsSnapshot,
        quantity: transactionItems.quantity,
        lineTotalCents: transactionItems.lineTotalCents,
      }).from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
      const trustedCart = buildTrustedReaderCart(transaction, itemSnapshots);
      try {
        validateReaderDisplayState(reader, trustedCart);
      } catch {
        throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state needs reconciliation—do not start another charge.", 503);
      }
      if (transaction.paymentStatus === "SENDING_TO_TERMINAL" && attempt.status === "READER_RESERVED" && !attempt.lastErrorCode) {
        return view(transaction.id, "SENDING_TO_TERMINAL");
      }
      const reservation = await reserveConfiguredReader(input.db, input.env, attempt.id);
      if (reservation.status === "TERMINAL_BUSY" || reservation.status === "TERMINAL_OFFLINE") {
        throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state needs reconciliation—do not start another charge.", 503);
      }
      const now = new Date();
      await input.db.update(paymentAttempts).set({
        status: "READER_RESERVED", terminalReaderId: reservation.readerId,
        lastErrorCode: null, lastErrorMessage: null, updatedAt: now,
      }).where(eq(paymentAttempts.id, attempt.id));
      await input.db.update(transactions).set({ paymentStatus: "SENDING_TO_TERMINAL", updatedAt: now })
        .where(and(eq(transactions.id, transaction.id), ne(transactions.paymentStatus, "PAID")));
      await extendReaderReservation(input.db, reservation.readerId, attempt.id);
      return view(transaction.id, "SENDING_TO_TERMINAL");
    }
    if (readerAction === "IDLE") {
      if (shouldDeferUnstartedPaymentReconciliation({
        attemptStatus: attempt.status,
        attemptUpdatedAt: attempt.updatedAt,
        now: new Date(),
      })) {
        return view(transaction.id, "SENDING_TO_TERMINAL");
      }
      const canceled = await markPaymentFailed({
        db: input.db,
        transactionId: transaction.id,
        paymentAttemptId: attempt.id,
        expectedPaymentIntentId: null,
        code: "no_payment_action_reconciled",
        message: "No PaymentIntent or reader payment action existed when the terminal state was reconciled.",
        canceled: true,
      });
      if (!canceled) {
        throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment status changed during reconciliation—do not retry.", 503);
      }
      return view(transaction.id, "CANCELED");
    }
    throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state needs reconciliation—do not start another charge.", 503);
  }

  const paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
  validateLivePaymentIntent({
    paymentIntent,
    expectedPaymentIntentId: attempt.stripePaymentIntentId,
    paymentAttemptId: attempt.id,
    transactionId: transaction.id,
    transactionNumber: transaction.number,
    amountCents: transaction.totalCents,
  });
  const decision = decidePolledPaymentReconciliation({
    paymentIntentStatus: paymentIntent.status,
    amountReceived: paymentIntent.amount_received,
    expectedAmountCents: transaction.totalCents,
    readerAction,
    readerActionStatus: reader.action?.status,
    readerPaymentIntentMatches: readerIntentId(reader) === paymentIntent.id,
    readerFailureCode: reader.action?.failure_code,
    attemptStatus: attempt.status,
  });
  if (decision === "SUCCEEDED") {
    await reconcileTerminalPaymentSuccess({
      db: input.db,
      env: input.env,
      transactionId: transaction.id,
      paymentAttemptId: attempt.id,
      paymentIntent,
      authoritativeReader: reader,
      managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL,
    });
    return view(transaction.id, "PAID");
  }
  if (decision === "CANCELED" || decision === "FAILED") {
    if (readerAction === "PAYMENT_ACTIVE" && readerIntentId(reader) === paymentIntent.id && reader.action?.status === "in_progress") {
      const cleared = await stripe.cancelReaderAction({
        readerId: reader.id,
        idempotencyKey: `${attempt.idempotencyKey}:definitive-${decision.toLowerCase()}`,
      });
      validateLiveReader(cleared, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
      if (classifyReaderAction(cleared) !== "IDLE") {
        throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state needs reconciliation—do not start another charge.", 503);
      }
    }
    await markPaymentFailed({
      db: input.db,
      transactionId: transaction.id,
      paymentAttemptId: attempt.id,
      expectedPaymentIntentId: paymentIntent.id,
      code: reader.action?.failure_code ?? (decision === "CANCELED" ? "stripe_canceled" : "reader_action_ended"),
      message: decision === "CANCELED" ? "Stripe confirmed that the payment was canceled." : "Stripe confirmed that card collection ended without payment.",
      canceled: decision === "CANCELED",
    });
    return view(transaction.id, decision === "CANCELED" ? "CANCELED" : "FAILED");
  }
  if (decision === "WAITING" || decision === "PROCESSING" || decision === "READY") {
    const nextAttemptStatus = decision === "WAITING" ? "WAITING_FOR_CUSTOMER" : decision === "PROCESSING" ? "PROCESSING" : "PAYMENT_INTENT_CREATED";
    const nextPaymentStatus = decision === "WAITING" ? "WAITING_FOR_CUSTOMER" : decision === "PROCESSING" ? "PROCESSING" : "READY";
    await input.db.update(paymentAttempts).set({
      status: nextAttemptStatus,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: new Date(),
    }).where(eq(paymentAttempts.id, attempt.id));
    await input.db.update(transactions).set({ paymentStatus: nextPaymentStatus, updatedAt: new Date() })
      .where(and(eq(transactions.id, transaction.id), ne(transactions.paymentStatus, "PAID")));
    if (attempt.terminalReaderId) await extendReaderReservation(input.db, attempt.terminalReaderId, attempt.id);
    return view(transaction.id, nextPaymentStatus);
  }
  throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state needs reconciliation—do not start another charge.", 503);
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
  db: Database;
  env: WorkerBindings;
  transactionId: string;
  stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  const configurationError = stripeLiveConfigurationError(input.env);
  if (configurationError) throw new TerminalFlowError("TERMINAL_NOT_CONFIGURED", configurationError, 503);
  const [attempt] = await input.db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.transactionId, input.transactionId)).orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
  if (!attempt) throw new TerminalFlowError("PAYMENT_NOT_FOUND", "No active payment was found", 404);
  const [transaction] = await input.db.select().from(transactions).where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  const stripe = input.stripe ?? createStripeTerminalClient(input.env);
  const reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
  validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
  const activeIntent = readerIntentId(reader);
  if (activeIntent && activeIntent !== attempt.stripePaymentIntentId) throw new TerminalFlowError("TERMINAL_BUSY", employeePaymentStatus.TERMINAL_BUSY, 409);
  if (!attempt.stripePaymentIntentId) throw new TerminalFlowError("PAYMENT_NOT_FOUND", "No active payment was found", 404);
  let paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
  validateLivePaymentIntent({
    paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
    paymentAttemptId: attempt.id,
    transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents,
  });
  if (paymentIntent.status === "succeeded") {
    await reconcileTerminalPaymentSuccess({
      db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
      env: input.env, paymentIntent, authoritativeReader: reader,
      managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL,
    });
    return view(transaction.id, "PAID");
  }
  if (reader.action?.status === "in_progress") {
    const canceledReader = await stripe.cancelReaderAction({ readerId: reader.id, idempotencyKey: `${attempt.idempotencyKey}:cancel` });
    validateLiveReader(canceledReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
    validateLivePaymentIntent({
      paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
      paymentAttemptId: attempt.id,
      transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents,
    });
    if (paymentIntent.status === "succeeded") {
      await reconcileTerminalPaymentSuccess({
        db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
        env: input.env, paymentIntent, authoritativeReader: canceledReader,
        managementNotificationEmail: input.env.PAYMENT_NOTIFICATION_EMAIL,
      });
      return view(transaction.id, "PAID");
    }
  }
  if (paymentIntent.status !== "canceled") {
    paymentIntent = await stripe.cancelPaymentIntent({
      paymentIntentId: paymentIntent.id,
      idempotencyKey: `${attempt.idempotencyKey}:cancel-intent`,
    });
    validateLivePaymentIntent({
      paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
      paymentAttemptId: attempt.id,
      transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents,
    });
    if (paymentIntent.status !== "canceled") {
      throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Payment cancellation is being verified. Do not start another charge.", 503);
    }
  }
  await markPaymentFailed({
    db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
    expectedPaymentIntentId: paymentIntent.id,
    code: "employee_canceled", message: "Payment canceled by employee.", canceled: true,
  });
  return view(input.transactionId, "CANCELED");
}

export async function clearTerminalDisplay(input: {
  db: Database;
  env: WorkerBindings;
  transactionId: string;
  reason?: "employee_abandoned" | "display_timeout";
  stripe?: StripeTerminalClient;
}): Promise<EmployeePaymentView> {
  const configurationError = stripeLiveConfigurationError(input.env);
  if (configurationError) throw new TerminalFlowError("TERMINAL_NOT_CONFIGURED", configurationError, 503);
  const [transaction] = await input.db.select().from(transactions)
    .where(eq(transactions.id, input.transactionId)).limit(1);
  if (!transaction) throw new TerminalFlowError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
  const [attempt] = await input.db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.transactionId, transaction.id)).orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
  if (!attempt) throw new TerminalFlowError("PAYMENT_NOT_FOUND", "No terminal display was found", 404);
  if (transaction.paymentStatus === "PAID" || transaction.stripePaymentIntentId || attempt.stripePaymentIntentId) {
    throw new TerminalFlowError("PAYMENT_ACTIVE", "Payment status is being checked. The terminal was not cleared.", 409);
  }
  if (attempt.status !== "READER_RESERVED") {
    throw new TerminalFlowError("DISPLAY_NOT_ACTIVE", "No terminal display is waiting to be cleared", 409);
  }

  const itemSnapshots = await input.db.select({
    productId: transactionItems.productId,
    productNameSnapshot: transactionItems.productNameSnapshot,
    unitPriceCentsSnapshot: transactionItems.unitPriceCentsSnapshot,
    quantity: transactionItems.quantity,
    lineTotalCents: transactionItems.lineTotalCents,
  }).from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
  const trustedCart = buildTrustedReaderCart(transaction, itemSnapshots);
  const claimed = await claimDisplayedCartTransition({
    db: input.db,
    attemptId: attempt.id,
    marker: "DISPLAY_CLEARING",
  });
  if (!claimed) {
    throw new TerminalFlowError("TERMINAL_BUSY", "Another terminal action is already in progress", 409);
  }
  try {
    const stripe = input.stripe ?? createStripeTerminalClient(input.env);
    const reader = await stripe.retrieveReader(input.env.STRIPE_TERMINAL_READER_ID!);
    validateLiveReader(reader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    const readerAction = classifyReaderAction(reader);
    const recovery = decideReaderDisplayRecovery({ readerAction, hasPaymentIntent: false });
    if (recovery === "REFUSE_UNCERTAIN") {
      throw new TerminalFlowError("PAYMENT_ACTIVE", "Payment in progress—do not retry. The terminal was not cleared.", 409);
    }
    if (recovery === "CLEAR_VERIFIED_CART") {
      validateReaderDisplayState(reader, trustedCart);
      const clearedReader = await stripe.cancelReaderAction({
        readerId: reader.id,
        idempotencyKey: `${attempt.idempotencyKey}:${input.reason ?? "employee_abandoned"}`,
      });
      validateLiveReader(clearedReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
      if (classifyReaderAction(clearedReader) !== "IDLE") {
        throw new TerminalFlowError("TERMINAL_UNCERTAIN", "Terminal state is being reconciled—do not retry", 503);
      }
    }
  } catch (error) {
    await input.db.update(paymentAttempts).set({ lastErrorCode: null, lastErrorMessage: null })
      .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.lastErrorCode, "DISPLAY_CLEARING"), isNull(paymentAttempts.stripePaymentIntentId)));
    throw error;
  }
  const reason = input.reason ?? "employee_abandoned";
  await markPaymentFailed({
    db: input.db,
    transactionId: transaction.id,
    paymentAttemptId: attempt.id,
    expectedPaymentIntentId: null,
    code: reason,
    message: reason === "display_timeout" ? "Terminal display expired before payment began." : "Terminal display cleared by employee.",
    canceled: true,
  });
  return view(transaction.id, "CANCELED");
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
