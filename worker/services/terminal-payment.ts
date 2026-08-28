import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { paymentAttempts, transactions } from "@/db/schema";
import { buildPaymentAttemptIdempotencyKey } from "@/domain/payments/idempotency";
import { employeePaymentStatus } from "@/domain/payments/status-display";
import {
  extendReaderReservation, releaseReaderReservation, reserveConfiguredReader, syncConfiguredReader,
} from "@/services/terminal/reader-reservation";
import { markPaymentFailed, markPaymentSucceeded } from "@worker/services/payment-reconciliation";
import {
  createStripeTerminalClient, StripeApiError, stripeLiveConfigurationError,
  validateLivePaymentIntent, validateLiveReader,
} from "@worker/services/stripe-client";
import type { StripeTerminalClient } from "@worker/services/stripe-client";
import type { WorkerBindings } from "@worker/types";

type PaymentAttempt = typeof paymentAttempts.$inferSelect;
type Transaction = typeof transactions.$inferSelect;

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
  return { transactionId, paymentStatus, displayStatus: employeePaymentStatus[paymentStatus] };
}

function readerIntentId(reader: Awaited<ReturnType<StripeTerminalClient["processPaymentIntent"]>>): string | null {
  const value = reader.action?.process_payment_intent?.payment_intent;
  return typeof value === "string" ? value : value?.id ?? null;
}

export function decideExistingPaymentIntentAction(input: { attemptStatus: PaymentAttempt["status"]; paymentIntentStatus: string }) {
  if (input.paymentIntentStatus === "succeeded") return "RECONCILE_SUCCESS" as const;
  if (["SENT_TO_READER", "WAITING_FOR_CUSTOMER", "PROCESSING"].includes(input.attemptStatus)) {
    return input.paymentIntentStatus === "processing" ? "SHOW_PROCESSING" as const : "SHOW_WAITING" as const;
  }
  if (input.paymentIntentStatus === "requires_payment_method") return "PROCESS_REUSING_INTENT" as const;
  return "SHOW_PROCESSING" as const;
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

  await syncConfiguredReader(input.db, input.env);
  let attempt = await getOrCreatePaymentAttempt(input.db, transaction);
  if (attempt.expectedAmountCents !== transaction.totalCents) throw new TerminalFlowError("AMOUNT_MISMATCH", "Stored payment amount is inconsistent");

  const reservation = await reserveConfiguredReader(input.db, input.env, attempt.id);
  if (reservation.status === "TERMINAL_OFFLINE") {
    await input.db.update(transactions).set({ paymentStatus: "TERMINAL_OFFLINE", updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
    throw new TerminalFlowError("TERMINAL_OFFLINE", employeePaymentStatus.TERMINAL_OFFLINE, 503);
  }
  if (reservation.status === "TERMINAL_BUSY") {
    await input.db.update(transactions).set({ paymentStatus: "TERMINAL_BUSY", updatedAt: new Date() }).where(eq(transactions.id, transaction.id));
    throw new TerminalFlowError("TERMINAL_BUSY", employeePaymentStatus.TERMINAL_BUSY, 409);
  }
  const internalReaderId = reservation.readerId;
  await input.db.update(paymentAttempts).set({ status: "READER_RESERVED", terminalReaderId: internalReaderId, updatedAt: new Date() })
    .where(eq(paymentAttempts.id, attempt.id));

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

  let paymentIntent;
  if (attempt.stripePaymentIntentId) {
    paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
    validateLivePaymentIntent({
      paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
      transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents,
    });
    const action = decideExistingPaymentIntentAction({ attemptStatus: attempt.status, paymentIntentStatus: paymentIntent.status });
    if (action === "RECONCILE_SUCCESS") {
      await markPaymentSucceeded({
        db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
        paymentIntent, readerId: stripeReader.id, locationId: input.env.STRIPE_TERMINAL_LOCATION_ID!,
        customerEmail: transaction.customerEmail,
      });
      return view(transaction.id, "PAID");
    }
    if (action === "SHOW_PROCESSING" || action === "SHOW_WAITING") {
      await extendReaderReservation(input.db, internalReaderId, attempt.id);
      return view(transaction.id, action === "SHOW_PROCESSING" ? "PROCESSING" : "WAITING_FOR_CUSTOMER");
    }
  } else {
    paymentIntent = await stripe.createPaymentIntent({
      amountCents: transaction.totalCents,
      idempotencyKey: attempt.idempotencyKey,
      metadata: {
        source: "brickellhouse_payments",
        transaction_number: transaction.number,
        unit_number: transaction.unitNumber,
        internal_transaction_id: transaction.id,
        payment_attempt_id: attempt.id,
      },
    });
    validateLivePaymentIntent({
      paymentIntent, transactionId: transaction.id,
      transactionNumber: transaction.number, amountCents: transaction.totalCents,
    });
    await input.db.update(paymentAttempts).set({
      stripePaymentIntentId: paymentIntent.id, status: "PAYMENT_INTENT_CREATED", updatedAt: new Date(),
    }).where(eq(paymentAttempts.id, attempt.id));
    await input.db.update(transactions).set({
      stripePaymentIntentId: paymentIntent.id, paymentStatus: "READY", updatedAt: new Date(),
    }).where(eq(transactions.id, transaction.id));
    attempt = { ...attempt, stripePaymentIntentId: paymentIntent.id, status: "PAYMENT_INTENT_CREATED" };
  }

  try {
    const processedReader = await stripe.processPaymentIntent({
      readerId: input.env.STRIPE_TERMINAL_READER_ID!,
      paymentIntentId: paymentIntent.id,
      idempotencyKey: `${attempt.idempotencyKey}:reader`,
    });
    validateLiveReader(processedReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    if (readerIntentId(processedReader) !== paymentIntent.id) throw new Error("Reader action is linked to an unexpected PaymentIntent.");
    await input.db.update(paymentAttempts).set({
      status: "WAITING_FOR_CUSTOMER", stripeReaderOperationId: `${processedReader.id}:${paymentIntent.id}`, updatedAt: new Date(),
      lastErrorCode: null, lastErrorMessage: null,
    }).where(eq(paymentAttempts.id, attempt.id));
    await input.db.update(transactions).set({
      paymentStatus: "WAITING_FOR_CUSTOMER", stripeReaderId: processedReader.id,
      stripeLocationId: input.env.STRIPE_TERMINAL_LOCATION_ID!, updatedAt: new Date(),
    }).where(eq(transactions.id, transaction.id));
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
    transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents,
  });
  if (paymentIntent.status === "succeeded") {
    await markPaymentSucceeded({
      db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
      paymentIntent, readerId: reader.id, locationId: input.env.STRIPE_TERMINAL_LOCATION_ID!,
      customerEmail: transaction.customerEmail,
    });
    return view(transaction.id, "PAID");
  }
  if (reader.action?.status === "in_progress") {
    const canceledReader = await stripe.cancelReaderAction({ readerId: reader.id, idempotencyKey: `${attempt.idempotencyKey}:cancel` });
    validateLiveReader(canceledReader, input.env.STRIPE_TERMINAL_READER_ID!, input.env.STRIPE_TERMINAL_LOCATION_ID!);
    paymentIntent = await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId);
    validateLivePaymentIntent({
      paymentIntent, expectedPaymentIntentId: attempt.stripePaymentIntentId,
      transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents,
    });
    if (paymentIntent.status === "succeeded") {
      await markPaymentSucceeded({
        db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
        paymentIntent, readerId: reader.id, locationId: input.env.STRIPE_TERMINAL_LOCATION_ID!,
        customerEmail: transaction.customerEmail,
      });
      return view(transaction.id, "PAID");
    }
  }
  await markPaymentFailed({
    db: input.db, transactionId: transaction.id, paymentAttemptId: attempt.id,
    code: "employee_canceled", message: "Payment canceled by employee.", canceled: true,
  });
  return view(input.transactionId, "CANCELED");
}
