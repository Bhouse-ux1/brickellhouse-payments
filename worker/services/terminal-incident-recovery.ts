import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { paymentAttempts, terminalReaderObservations, terminalReaders, transactions } from "@/db/schema";
import { createStripeTerminalClient, validateLivePaymentIntent, validateLiveReader } from "./stripe-client";
import type { StripePaymentIntent, StripeReader, StripeTerminalClient } from "./stripe-client";
import { markPaymentFailed } from "./payment-reconciliation";
import type { WorkerBindings } from "@worker/types";

const transactionId = "3971ba79-1704-4e95-a189-2857847a3075";
const attemptId = "c6e7f64f-b300-41b4-bba9-2eb0cf00d408";
const paymentIntentId = "pi_3UG1xuH75hxIRBjq1GM9C9FR";

export function incidentStripeStateAllowsCancellation(reader: StripeReader, intent: StripePaymentIntent & { payment_method?: unknown }) {
  return reader.status === "online" && !reader.action && intent.status === "requires_payment_method" &&
    intent.payment_method === null && intent.latest_charge === null && intent.amount_received === 0;
}

export async function recoverTerminalIncident(db: Database, env: WorkerBindings,
  providedStripe?: Pick<StripeTerminalClient, "retrieveReader" | "retrievePaymentIntent" | "cancelPaymentIntent">) {
  const stripe = providedStripe ?? createStripeTerminalClient(env, async (request, init) => {
    const url = String(request);
    const allowed = init?.method === "GET" || (init?.method === "POST" && url === `https://api.stripe.com/v1/payment_intents/${paymentIntentId}/cancel`);
    if (!allowed) throw new Error("Incident recovery request refused");
    return fetch(request, { ...init, signal: AbortSignal.timeout(15_000) });
  });
  return db.transaction(async tx => {
    const [transaction] = await tx.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1).for("update");
    const [attempt] = await tx.select().from(paymentAttempts).where(and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.transactionId, transactionId))).limit(1).for("update");
    const [reservation] = await tx.select().from(terminalReaders).where(eq(terminalReaders.stripeReaderId, env.STRIPE_TERMINAL_READER_ID!)).limit(1).for("update");
    const observations = await tx.select({ status: terminalReaderObservations.actionStatus }).from(terminalReaderObservations)
      .where(eq(terminalReaderObservations.transactionId, transactionId));
    const refuse = () => ({ transactionReference: "POS-000026", outcome: "REFUSED", decision: "RECONCILIATION_REQUIRED", changed: false } as const);
    if (!transaction || transaction.number !== "POS-000026" || !attempt || !reservation ||
      transaction.paymentStatus !== "SENDING_TO_TERMINAL" || attempt.status !== "READER_RESERVED" ||
      transaction.stripePaymentIntentId !== paymentIntentId || attempt.stripePaymentIntentId !== paymentIntentId ||
      transaction.stripeChargeId || transaction.paidAt || attempt.stripeReaderOperationId || attempt.lastErrorCode ||
      attempt.expectedAmountCents !== transaction.totalCents || attempt.terminalReaderId !== reservation.id ||
      !reservation.active || reservation.stripeLocationId !== env.STRIPE_TERMINAL_LOCATION_ID || reservation.lockPaymentAttemptId !== attemptId ||
      observations.some(o => o.status !== "failed")) return refuse();

    const reader = await stripe.retrieveReader(env.STRIPE_TERMINAL_READER_ID!);
    const intent = await stripe.retrievePaymentIntent(paymentIntentId);
    validateLiveReader(reader, env.STRIPE_TERMINAL_READER_ID!, env.STRIPE_TERMINAL_LOCATION_ID!);
    const validate = (paymentIntent: StripePaymentIntent) => validateLivePaymentIntent({ paymentIntent, expectedPaymentIntentId: paymentIntentId,
      paymentAttemptId: attemptId, transactionId, transactionNumber: transaction.number, amountCents: transaction.totalCents });
    validate(intent);
    if (!incidentStripeStateAllowsCancellation(reader, intent)) return refuse();

    // Stripe's cancellation is the authority: a success/processing race must not be recorded as canceled.
    const canceled = await stripe.cancelPaymentIntent({ paymentIntentId, idempotencyKey: `${attempt.idempotencyKey}:cancel-intent` });
    validate(canceled);
    if (canceled.status !== "canceled" || canceled.amount_received !== 0 || canceled.latest_charge ||
        (canceled as StripePaymentIntent & { payment_method?: unknown }).payment_method) throw new Error("Cancellation requires reconciliation");
    if (!await markPaymentFailed({ db: tx, transactionId, paymentAttemptId: attemptId, expectedPaymentIntentId: paymentIntentId,
      canceled: true, code: "employee_canceled", message: "Employee authorized cancellation after fresh incident reconciliation." })) {
      throw new Error("Cancellation requires reconciliation");
    }
    return { transactionReference: "POS-000026", outcome: "CANCELED", paymentIntentStatus: "canceled", reservationReleased: true, readerCommandSent: false } as const;
  });
}
