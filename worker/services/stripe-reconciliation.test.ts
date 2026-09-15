import { describe, expect, it, vi } from "vitest";
import { buildBrickellHousePaymentIntentMetadata } from "./stripe-client";
import {
  decideReconciliation, persistOwnedReaderObservation, processStripeEvent, recoverOwnedPaymentContext,
} from "./stripe-reconciliation";

const attemptId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const readerRowId = "33333333-3333-4333-8333-333333333333";

const ownedIntent = {
  id: "pi_owned",
  object: "payment_intent" as const,
  amount: 1_000,
  amount_received: 1_000,
  currency: "usd",
  status: "succeeded",
  livemode: true,
  payment_method_types: ["card_present"],
  metadata: buildBrickellHousePaymentIntentMetadata({ attemptId, transactionId, transactionNumber: "POS-000001" }),
  latest_charge: {
    id: "ch_owned", object: "charge" as const, payment_intent: "pi_owned", paid: true,
    captured: true, livemode: true, amount: 1_000, amount_captured: 1_000, currency: "usd",
  },
};

const attempt = {
  id: attemptId,
  transactionId,
  expectedAmountCents: 1_000,
  stripePaymentIntentId: "pi_owned",
  terminalReaderId: readerRowId,
  stripeReaderOperationId: "tmr_live:pi_owned",
  status: "WAITING_FOR_CUSTOMER",
};

const transaction = {
  id: transactionId,
  number: "POS-000001",
  totalCents: 1_000,
  customerEmail: "resident@example.com",
  stripePaymentIntentId: "pi_owned",
  stripeChargeId: null,
  stripeReaderId: "tmr_live",
  stripeLocationId: "tml_live",
  paymentStatus: "PROCESSING",
  paymentMethod: null,
  paidAt: null,
};

const successfulReader = {
  id: "tmr_live", object: "terminal.reader" as const, livemode: true, location: "tml_live",
  action: { type: "process_payment_intent", status: "succeeded", process_payment_intent: { payment_intent: "pi_owned" } },
};

const liveEnv = {
  STRIPE_TERMINAL_READER_ID: "tmr_live",
  STRIPE_TERMINAL_LOCATION_ID: "tml_live",
};

function createEventDb(selectResults: unknown[][] = []) {
  const results = [...selectResults];
  const limit = vi.fn(async () => results.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const updateWhere = vi.fn(async () => []);
  const set = vi.fn(() => ({ where: updateWhere }));
  const observationValues = vi.fn(() => ({
    onConflictDoNothing: () => ({ returning: vi.fn(async () => [{ id: "observation-row" }]) }),
  }));
  const observationTx = {
    insert: vi.fn(() => ({ values: observationValues })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: vi.fn(async () => []) }) }) })),
  };
  return {
    insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: vi.fn(async () => [{ id: "event-row" }]) }) }) })),
    select: vi.fn(() => ({ from })),
    update: vi.fn(() => ({ set })),
    transaction: vi.fn(async (callback: (value: typeof observationTx) => Promise<void>) => callback(observationTx)),
    _updateWhere: updateWhere,
    _observationValues: observationValues,
  };
}

describe("Stripe reconciliation decisions", () => {
  it("requires exact received amount before success", () => {
    expect(decideReconciliation({ eventType: "payment_intent.succeeded", paymentIntentStatus: "succeeded", amountReceived: 10_000, expectedAmountCents: 10_000 })).toBe("SUCCEEDED");
    expect(decideReconciliation({ eventType: "payment_intent.succeeded", paymentIntentStatus: "succeeded", amountReceived: 9_999, expectedAmountCents: 10_000 })).toBe("PROCESSING");
  });

  it("handles declined, canceled, and uncertain reader results", () => {
    expect(decideReconciliation({ eventType: "terminal.reader.action_failed", paymentIntentStatus: "requires_payment_method", expectedAmountCents: 10_000, failureCode: "card_declined" })).toBe("FAILED");
    expect(decideReconciliation({ eventType: "terminal.reader.action_failed", paymentIntentStatus: "canceled", expectedAmountCents: 10_000, failureCode: "customer_canceled" })).toBe("CANCELED");
    expect(decideReconciliation({ eventType: "terminal.reader.action_failed", paymentIntentStatus: "processing", expectedAmountCents: 10_000, failureCode: "connection_error" })).toBe("PROCESSING");
    expect(decideReconciliation({ eventType: "payment_intent.payment_failed", paymentIntentStatus: "requires_capture", expectedAmountCents: 10_000 })).toBe("PROCESSING");
  });

  it("acknowledges an unrelated succeeded PaymentIntent without creating business records or receipts", async () => {
    const db = createEventDb();
    const finalizeSucceeded = vi.fn();
    const unrelated = { ...ownedIntent, id: "pi_unrelated", metadata: { x_terminal_standalone_note: "" } };
    const stripe = { retrievePaymentIntent: vi.fn(async () => unrelated) };
    const result = await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "unrelated-event",
      event: { id: "evt_unrelated", object: "event", type: "payment_intent.succeeded", livemode: true, data: { object: unrelated } },
      stripe: stripe as never,
      finalizeSucceeded,
    });
    expect(result).toEqual({ received: true, ignored: true });
    expect(db.insert).toHaveBeenCalledOnce();
    expect(db.select).not.toHaveBeenCalled();
    expect(finalizeSucceeded).not.toHaveBeenCalled();
  });

  it("reconciles an owned PaymentIntent with an existing durable mapping exactly once", async () => {
    const db = createEventDb([[attempt], [transaction]]);
    const finalizeSucceeded = vi.fn(async () => undefined);
    const retrieveReader = vi.fn(async () => successfulReader);
    const result = await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "owned-event",
      event: { id: "evt_owned", object: "event", type: "payment_intent.succeeded", livemode: true, data: { object: ownedIntent } },
      stripe: {
        retrievePaymentIntent: vi.fn(async () => ownedIntent),
        retrieveReader,
      } as never,
      finalizeSucceeded,
    });
    expect(result).toEqual({ received: true, duplicate: false, paidTransactionId: transactionId });
    expect(finalizeSucceeded).toHaveBeenCalledOnce();
    expect(finalizeSucceeded).toHaveBeenCalledWith(expect.objectContaining({ transactionId, paymentAttemptId: attemptId }));
    expect(retrieveReader).toHaveBeenCalledWith("tmr_live");
  });

  it("uses the signed terminal.reader.action_succeeded object as authoritative reader evidence", async () => {
    const db = createEventDb([[attempt], [transaction]]);
    const finalizeSucceeded = vi.fn(async () => undefined);
    const retrieveReader = vi.fn();
    await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "reader-success",
      event: {
        id: "evt_reader_success", object: "event", type: "terminal.reader.action_succeeded", livemode: true,
        data: { object: successfulReader },
      },
      stripe: { retrievePaymentIntent: vi.fn(async () => ownedIntent), retrieveReader } as never,
      finalizeSucceeded,
    });
    expect(finalizeSucceeded).toHaveBeenCalledWith(expect.objectContaining({ authoritativeReader: successfulReader }));
    expect(retrieveReader).not.toHaveBeenCalled();
    expect(db._observationValues).toHaveBeenCalledWith(expect.objectContaining({
      stripeEventId: "evt_reader_success",
      readerId: "tmr_live",
      locationId: "tml_live",
      liveMode: true,
      actionType: "process_payment_intent",
      actionStatus: "succeeded",
      stripePaymentIntentId: "pi_owned",
      paymentAttemptId: attemptId,
      transactionId,
    }));
  });

  it("persists Reader success before acknowledging it when the PaymentIntent is still processing", async () => {
    const processingIntent = { ...ownedIntent, status: "processing", amount_received: 0, latest_charge: null };
    const db = createEventDb([[attempt], [transaction]]);
    const result = await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "reader-first",
      event: {
        id: "evt_reader_first", object: "event", type: "terminal.reader.action_succeeded", livemode: true,
        data: { object: successfulReader },
      },
      stripe: { retrievePaymentIntent: vi.fn(async () => processingIntent) } as never,
    });
    expect(result).toEqual({ received: true, duplicate: false, paidTransactionId: undefined });
    expect(db._observationValues).toHaveBeenCalledOnce();
    expect(db.update).toHaveBeenCalledTimes(3);
  });

  it("accepts an exact duplicate Reader Event ID without inserting conflicting evidence", async () => {
    const exactObservation = {
      stripeEventId: "evt_reader_duplicate", readerId: "tmr_live", locationId: "tml_live", liveMode: true,
      actionType: "process_payment_intent", actionStatus: "succeeded", stripePaymentIntentId: "pi_owned",
      paymentAttemptId: attemptId, transactionId,
    };
    const tx = {
      insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: vi.fn(async () => []) }) }) })),
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: vi.fn(async () => [exactObservation]) }) }) })),
    };
    const db = { transaction: vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)) };
    await expect(persistOwnedReaderObservation({
      db: db as never,
      eventId: "evt_reader_duplicate",
      reader: successfulReader,
      paymentIntentId: "pi_owned",
      context: { attempt, transaction, recovered: false } as never,
    })).resolves.toBeUndefined();
  });

  it("allows different successful Reader Event IDs for the same owned payment", async () => {
    const eventIds: string[] = [];
    const tx = {
      insert: vi.fn(() => ({ values: (value: { stripeEventId: string }) => {
        eventIds.push(value.stripeEventId);
        return { onConflictDoNothing: () => ({ returning: vi.fn(async () => [{ id: value.stripeEventId }]) }) };
      } })),
      select: vi.fn(),
    };
    const db = { transaction: vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)) };
    await Promise.all(["evt_reader_a", "evt_reader_b"].map((eventId) => persistOwnedReaderObservation({
      db: db as never, eventId, reader: successfulReader, paymentIntentId: "pi_owned",
      context: { attempt, transaction, recovered: false } as never,
    })));
    expect(eventIds.sort()).toEqual(["evt_reader_a", "evt_reader_b"]);
  });

  it("recovers an owned missing mapping only onto the matching durable attempt and transaction", async () => {
    const unmappedAttempt = { ...attempt, stripePaymentIntentId: null, status: "READER_RESERVED" };
    const unmappedTransaction = { ...transaction, stripePaymentIntentId: null, paymentStatus: "SENDING_TO_TERMINAL" };
    const mappedAttempt = { ...unmappedAttempt, stripePaymentIntentId: "pi_owned" };
    const mappedTransaction = { ...unmappedTransaction, stripePaymentIntentId: "pi_owned" };
    const reader = { id: readerRowId, stripeReaderId: "tmr_live", stripeLocationId: "tml_live" };
    const results = [[unmappedAttempt], [unmappedTransaction], [reader], [mappedAttempt], [mappedTransaction]];
    const limit = vi.fn(async () => results.shift() ?? []);
    const db = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback({
        update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: vi.fn(async () => [{ id: "updated" }]) }) }) })),
      })),
    };
    const recovered = await recoverOwnedPaymentContext({
      db: db as never,
      env: liveEnv as never,
      paymentIntent: ownedIntent,
      ownership: { classification: "OWNED", source: "brickellhouse_terminal", attemptId, transactionId, transactionNumber: "POS-000001" },
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.attempt.stripePaymentIntentId).toBe("pi_owned");
    expect(recovered.transaction.stripePaymentIntentId).toBe("pi_owned");
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it("refuses to overwrite an attempt already mapped to a different PaymentIntent", async () => {
    const conflictingAttempt = { ...attempt, stripePaymentIntentId: "pi_different" };
    const db = createEventDb([[conflictingAttempt], [transaction]]);
    await expect(recoverOwnedPaymentContext({
      db: db as never,
      env: liveEnv as never,
      paymentIntent: ownedIntent,
      ownership: { classification: "OWNED", source: "brickellhouse_terminal", attemptId, transactionId, transactionNumber: "POS-000001" },
    })).rejects.toThrow(/another PaymentIntent/u);
  });

  it("fails closed when owned recovery amount, currency, or mode is wrong", async () => {
    for (const paymentIntent of [
      { ...ownedIntent, amount: 999 },
      { ...ownedIntent, currency: "eur" },
      { ...ownedIntent, livemode: false },
    ]) {
      const db = createEventDb([[{ ...attempt, stripePaymentIntentId: null }], [{ ...transaction, stripePaymentIntentId: null }]]);
      await expect(recoverOwnedPaymentContext({
        db: db as never,
        env: liveEnv as never,
        paymentIntent,
        ownership: { classification: "OWNED", source: "brickellhouse_terminal", attemptId, transactionId, transactionNumber: "POS-000001" },
      })).rejects.toThrow();
    }
  });

  it("rejects orphan recovery with Charge, paid-at, payment-method, or final-state conflicts", async () => {
    for (const conflict of [
      { stripeChargeId: "ch_existing" },
      { paidAt: new Date() },
      { paymentMethod: "STRIPE_TERMINAL" },
      { paymentStatus: "PAID" },
    ]) {
      const db = createEventDb([
        [{ ...attempt, stripePaymentIntentId: null }],
        [{ ...transaction, stripePaymentIntentId: null, ...conflict }],
      ]);
      await expect(recoverOwnedPaymentContext({
        db: db as never,
        env: liveEnv as never,
        paymentIntent: ownedIntent,
        ownership: { classification: "OWNED", source: "brickellhouse_terminal", attemptId, transactionId, transactionNumber: "POS-000001" },
      })).rejects.toThrow(/conflict/u);
    }
  });

  it("uses current succeeded state instead of a delayed payment_failed event", async () => {
    const db = createEventDb([[attempt], [transaction]]);
    const finalizeSucceeded = vi.fn(async () => undefined);
    const finalizeFailed = vi.fn(async () => true);
    const result = await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "delayed-failure",
      event: { id: "evt_delayed_failure", object: "event", type: "payment_intent.payment_failed", livemode: true, data: { object: ownedIntent } },
      stripe: {
        retrievePaymentIntent: vi.fn(async () => ownedIntent),
        retrieveReader: vi.fn(async () => successfulReader),
      } as never,
      finalizeSucceeded,
      finalizeFailed,
    });
    expect(result.paidTransactionId).toBe(transactionId);
    expect(finalizeSucceeded).toHaveBeenCalledOnce();
    expect(finalizeFailed).not.toHaveBeenCalled();
  });

  it("uses current succeeded state instead of a stale terminal.reader.action_failed event", async () => {
    const failedReader = {
      ...successfulReader,
      action: {
        type: "process_payment_intent", status: "failed", failure_code: "connection_error",
        failure_message: "Delayed failure", process_payment_intent: { payment_intent: "pi_owned" },
      },
    };
    const db = createEventDb([[attempt], [transaction]]);
    const finalizeSucceeded = vi.fn(async () => undefined);
    const finalizeFailed = vi.fn(async () => true);
    const result = await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "stale-reader-failure",
      event: {
        id: "evt_stale_reader_failure", object: "event", type: "terminal.reader.action_failed", livemode: true,
        data: { object: failedReader },
      },
      stripe: { retrievePaymentIntent: vi.fn(async () => ownedIntent) } as never,
      finalizeSucceeded,
      finalizeFailed,
    });
    expect(result.paidTransactionId).toBe(transactionId);
    expect(finalizeSucceeded).toHaveBeenCalledOnce();
    expect(finalizeFailed).not.toHaveBeenCalled();
  });

  it("does not mark a delayed failure FAILED while current Stripe state is processing", async () => {
    const processingIntent = { ...ownedIntent, status: "processing", amount_received: 0, latest_charge: null };
    const db = createEventDb([[attempt], [transaction]]);
    const finalizeFailed = vi.fn(async () => true);
    const result = await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "processing-failure",
      event: { id: "evt_processing_failure", object: "event", type: "payment_intent.payment_failed", livemode: true, data: { object: processingIntent } },
      stripe: { retrievePaymentIntent: vi.fn(async () => processingIntent) } as never,
      finalizeFailed,
    });
    expect(result.paidTransactionId).toBeUndefined();
    expect(finalizeFailed).not.toHaveBeenCalled();
  });

  it("still transitions a genuinely current failed state", async () => {
    const failedIntent = { ...ownedIntent, status: "requires_payment_method", amount_received: 0, latest_charge: null };
    const db = createEventDb([[attempt], [transaction]]);
    const finalizeFailed = vi.fn(async () => true);
    await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "current-failure",
      event: { id: "evt_current_failure", object: "event", type: "payment_intent.payment_failed", livemode: true, data: { object: failedIntent } },
      stripe: { retrievePaymentIntent: vi.fn(async () => failedIntent) } as never,
      finalizeFailed,
    });
    expect(finalizeFailed).toHaveBeenCalledOnce();
  });

  it("ignores a duplicate event before any Stripe action", async () => {
    const hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("{}")));
    const payloadSha256 = [...hashBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const returning = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockResolvedValue([{ id: "row-1", payloadSha256, processedAt: new Date() }]);
    const db = {
      insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) })),
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
    };
    const stripe = { retrievePaymentIntent: vi.fn() };
    const result = await processStripeEvent({
      db: db as never,
      env: {} as never,
      rawBody: "{}",
      event: { id: "evt_duplicate", object: "event", type: "payment_intent.succeeded", livemode: true, data: { object: {} } },
      stripe: stripe as never,
    });
    expect(result).toEqual({ received: true, duplicate: true });
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("classifies an initial stripe_events database failure as retryable reconciliation", async () => {
    const db = {
      insert: vi.fn(() => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: vi.fn(async () => { throw new Error("database unavailable"); }) }) }),
      })),
    };
    await expect(processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "ledger-failure",
      event: { id: "evt_ledger_failure", object: "event", type: "payment_intent.succeeded", livemode: true, data: { object: ownedIntent } },
      stripe: { retrievePaymentIntent: vi.fn() } as never,
    })).rejects.toMatchObject({ name: "StripeReconciliationError" });
  });

  it("records reader-display webhooks as ignored instead of treating them as payment events", async () => {
    const db = createEventDb();
    const result = await processStripeEvent({
      db: db as never,
      env: {} as never,
      rawBody: "display-event",
      event: {
        id: "evt_display", object: "event", type: "terminal.reader.action_succeeded", livemode: true,
        data: { object: { id: "tmr_live", object: "terminal.reader", action: { type: "set_reader_display", status: "succeeded" } } },
      },
      stripe: { retrievePaymentIntent: vi.fn() } as never,
    });
    expect(result).toEqual({ received: true, ignored: true });
    expect(db.update).toHaveBeenCalledOnce();
  });

  it("safely acknowledges action_updated after the Reader action has cleared", async () => {
    const db = createEventDb();
    const result = await processStripeEvent({
      db: db as never,
      env: liveEnv as never,
      rawBody: "cleared-action",
      event: {
        id: "evt_action_cleared", object: "event", type: "terminal.reader.action_updated", livemode: true,
        data: { object: { ...successfulReader, action: null } },
      },
      stripe: { retrievePaymentIntent: vi.fn() } as never,
    });
    expect(result).toEqual({ received: true, ignored: true });
    expect(db._observationValues).not.toHaveBeenCalled();
  });
});
