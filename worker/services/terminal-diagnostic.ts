import { desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { paymentAttempts, stripeEvents, terminalReaderObservations, terminalReaders, transactionItems, transactions } from "@/db/schema";
import { buildTrustedReaderCart } from "@/domain/payments/reader-cart";
import { createStripeTerminalClient, validateLivePaymentIntent, validateLiveReader, validateReaderDisplayState } from "./stripe-client";
import type { StripePaymentIntent, StripeReader } from "./stripe-client";
import type { WorkerBindings } from "@worker/types";

// Retained Admin diagnostic scope: callers cannot select another transaction or Reader.
const INCIDENT_TRANSACTION_ID = "3971ba79-1704-4e95-a189-2857847a3075";

const allowed = (value: string | undefined, values: readonly string[]) => value && values.includes(value) ? value : "unknown";

export function safeDiagnosticResult(input: {
  reader: StripeReader;
  intent: (StripePaymentIntent & { payment_method?: unknown }) | null;
  transactionStatus: string;
  attemptStatus: string;
  identityAndAmountMatch: boolean;
  readerMatches: boolean;
  cartMatches: boolean;
  mappingMatches: boolean;
  reservationOwned: boolean;
  hasRecordedOperation: boolean;
  hasRecordedCharge: boolean;
  hasPaidAt: boolean;
  hasNonfailedObservation: boolean;
  databaseChanged: boolean;
  readerLockCount?: number;
}) {
  const { reader, intent } = input;
  const reference = reader.action?.process_payment_intent?.payment_intent;
  const readerIntentId = typeof reference === "string" ? reference : reference?.id;
  const readerPaymentMatches = Boolean(intent && readerIntentId === intent.id);
  const readerSucceeded = readerPaymentMatches && reader.action?.status === "succeeded";
  const readerActive = reader.action?.type === "process_payment_intent" && reader.action.status === "in_progress";
  const idle = !reader.action || (reader.action.type === "process_payment_intent" && ["failed", "succeeded"].includes(reader.action.status ?? ""));
  const preCard = intent?.status === "requires_payment_method" && intent.amount_received === 0 &&
    !intent.payment_method && !intent.latest_charge && !input.hasRecordedOperation && !input.hasRecordedCharge &&
    !input.hasPaidAt && !input.hasNonfailedObservation && !readerSucceeded && input.reservationOwned &&
    reader.status === "online" && (idle || input.cartMatches) &&
    ["READER_RESERVED", "PAYMENT_INTENT_CREATED"].includes(input.attemptStatus) &&
    ["SENDING_TO_TERMINAL", "READY"].includes(input.transactionStatus);
  let decision = "RECONCILIATION_REQUIRED";
  if (!input.databaseChanged && input.readerMatches && input.mappingMatches && input.identityAndAmountMatch) {
    if (intent?.status === "succeeded" || input.hasPaidAt || input.transactionStatus === "PAID") decision = "SUCCESS_REQUIRES_EXISTING_STRICT_FINALIZATION";
    else if (intent?.status === "processing" || (readerActive && readerPaymentMatches)) decision = "PAYMENT_ACTIVE";
    else if (intent?.status === "canceled" && idle && !input.hasRecordedCharge && !input.hasNonfailedObservation && !readerSucceeded) {
      decision = input.transactionStatus === "CANCELED" && input.attemptStatus === "CANCELED" && input.readerLockCount === 0 && reader.status === "online" && !reader.action
        ? "CANCELED_READER_READY" : "STRIPE_CANCELED_REQUIRES_DATABASE_RECONCILIATION";
    }
    else if (preCard) decision = "PRE_CARD_CANCEL_CANDIDATE_RECHECK_BEFORE_ANY_ACTION";
  }
  return {
    reader: {
      status: allowed(reader.status, ["online", "offline"]),
      actionType: reader.action ? allowed(reader.action.type, ["set_reader_display", "process_payment_intent"]) : null,
      actionStatus: reader.action ? allowed(reader.action.status, ["in_progress", "succeeded", "failed"]) : null,
      configuredIdentityMatches: input.readerMatches,
      actionPaymentIntentMatches: readerPaymentMatches,
      trustedCartMatches: input.cartMatches,
    },
    paymentIntent: {
      exists: Boolean(intent),
      status: intent ? allowed(intent.status, ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"]) : null,
      paymentMethodExists: Boolean(intent?.payment_method),
      latestChargeExists: Boolean(intent?.latest_charge),
      receivedAmountIsZero: intent ? intent.amount_received === 0 : null,
      identityOwnershipAmountCurrencyAndLiveModeMatch: input.identityAndAmountMatch,
    },
    decision,
    databaseChangedDuringRead: input.databaseChanged,
  };
}

export async function readTerminalDiagnostic(db: Database, env: WorkerBindings) {
  // Defense in depth: even accidental use of a mutating Stripe client method fails locally.
  const readOnlyFetch: typeof fetch = async (request, init) => {
    if (init?.method !== "GET") throw new Error("Diagnostic only permits retrieval");
    return fetch(request, { ...init, signal: AbortSignal.timeout(15_000) });
  };
  const stripe = createStripeTerminalClient(env, readOnlyFetch);
  return db.transaction(async (tx) => {
    async function snapshot() {
      const [transaction] = await tx.select().from(transactions).where(eq(transactions.id, INCIDENT_TRANSACTION_ID)).limit(1);
      const [attempt] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.transactionId, INCIDENT_TRANSACTION_ID)).orderBy(desc(paymentAttempts.attemptNumber)).limit(1);
      const [reservation] = await tx.select().from(terminalReaders).where(eq(terminalReaders.stripeReaderId, env.STRIPE_TERMINAL_READER_ID!)).limit(1);
      const observations = await tx.select({ status: terminalReaderObservations.actionStatus }).from(terminalReaderObservations)
        .where(eq(terminalReaderObservations.transactionId, INCIDENT_TRANSACTION_ID));
      return { transaction, attempt, reservation, observations };
    }
    const before = await snapshot();
    const { transaction, attempt, reservation, observations } = before;
    if (!transaction || !attempt || !reservation) throw new Error("Incident records unavailable");
    const reader = await stripe.retrieveReader(env.STRIPE_TERMINAL_READER_ID!);
    const intent = attempt.stripePaymentIntentId ? await stripe.retrievePaymentIntent(attempt.stripePaymentIntentId) : null;
    let readerMatches = false;
    let identityAndAmountMatch = false;
    let cartMatches = false;
    try { validateLiveReader(reader, env.STRIPE_TERMINAL_READER_ID!, env.STRIPE_TERMINAL_LOCATION_ID!); readerMatches = true; } catch { /* Report mismatch without provider data. */ }
    if (intent) {
      try {
        validateLivePaymentIntent({ paymentIntent: intent, expectedPaymentIntentId: attempt.stripePaymentIntentId, paymentAttemptId: attempt.id,
          transactionId: transaction.id, transactionNumber: transaction.number, amountCents: transaction.totalCents });
        identityAndAmountMatch = true;
      } catch { /* Report mismatch without provider data. */ }
    }
    const items = await tx.select().from(transactionItems).where(eq(transactionItems.transactionId, transaction.id));
    try { validateReaderDisplayState(reader, buildTrustedReaderCart(transaction, items)); cartMatches = true; } catch { /* Non-cart or mismatching display. */ }
    const events = await tx.select({ processed: stripeEvents.processedAt, error: stripeEvents.processingError }).from(stripeEvents)
      .where(gte(stripeEvents.receivedAt, attempt.createdAt));
    const locks = await tx.select({ id: terminalReaders.id }).from(terminalReaders).where(isNotNull(terminalReaders.lockPaymentAttemptId));
    const after = await snapshot();
    const mappingMatches = attempt.stripePaymentIntentId === transaction.stripePaymentIntentId &&
      attempt.expectedAmountCents === transaction.totalCents && attempt.terminalReaderId === reservation.id &&
      reservation.stripeLocationId === env.STRIPE_TERMINAL_LOCATION_ID && reservation.active &&
      (!transaction.stripeReaderId || transaction.stripeReaderId === env.STRIPE_TERMINAL_READER_ID) &&
      (!transaction.stripeLocationId || transaction.stripeLocationId === env.STRIPE_TERMINAL_LOCATION_ID);
    return {
      checkedAt: new Date().toISOString(),
      readOnly: true,
      transactionReference: transaction.number,
      transactionStatus: transaction.paymentStatus,
      attemptStatus: attempt.status,
      attemptUpdatedAt: attempt.updatedAt,
      paymentIntentMappingMatches: mappingMatches,
      readerOperationRecorded: Boolean(attempt.stripeReaderOperationId),
      chargeRecorded: Boolean(transaction.stripeChargeId),
      readerLockCount: locks.length,
      reservationOwnedByAttempt: reservation.lockPaymentAttemptId === attempt.id,
      reservationExpiresAt: reservation.lockExpiresAt,
      durableReaderObservations: {
        total: observations.length,
        succeeded: observations.filter(o => o.status === "succeeded").length,
        inProgress: observations.filter(o => o.status === "in_progress").length,
        failed: observations.filter(o => o.status === "failed").length,
      },
      // The event ledger does not map every event to an attempt; avoid implying that it does.
      ledgerSinceAttemptCreated: { total: events.length, processed: events.filter(e => e.processed).length, withErrors: events.filter(e => e.error).length },
      ...safeDiagnosticResult({ reader, intent, transactionStatus: transaction.paymentStatus, attemptStatus: attempt.status,
        identityAndAmountMatch, readerMatches, cartMatches, mappingMatches, reservationOwned: reservation.lockPaymentAttemptId === attempt.id,
        hasRecordedOperation: Boolean(attempt.stripeReaderOperationId), hasRecordedCharge: Boolean(transaction.stripeChargeId), hasPaidAt: Boolean(transaction.paidAt),
        hasNonfailedObservation: observations.some(o => o.status !== "failed"), readerLockCount: locks.length, databaseChanged: JSON.stringify(before) !== JSON.stringify(after) }),
    };
  }, { accessMode: "read only", isolationLevel: "read committed" });
}
