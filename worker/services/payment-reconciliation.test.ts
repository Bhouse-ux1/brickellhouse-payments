import { describe, expect, it, vi } from "vitest";
import { buildBrickellHousePaymentIntentMetadata } from "./stripe-client";
import type { StripeReader } from "./stripe-client";
import {
  buildPaidDeliveryRows, markPaymentFailed, reconcileTerminalPaymentSuccess, verifyTerminalPaymentForFinalization,
} from "./payment-reconciliation";

const attemptId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const env = { STRIPE_TERMINAL_READER_ID: "tmr_live", STRIPE_TERMINAL_LOCATION_ID: "tml_live" };
const successfulIntent = {
  id: "pi_live", object: "payment_intent" as const, amount: 1_000, amount_received: 1_000,
  currency: "usd", status: "succeeded", livemode: true, payment_method_types: ["card_present"],
  metadata: buildBrickellHousePaymentIntentMetadata({ attemptId, transactionId, transactionNumber: "POS-000001" }),
  latest_charge: {
    id: "ch_live", object: "charge" as const, payment_intent: "pi_live", paid: true,
    captured: true, livemode: true, amount: 1_000, amount_captured: 1_000, currency: "usd",
    payment_method_details: { card_present: { brand: "visa", last4: "4242" } },
  },
};
const attempt = {
  id: attemptId, transactionId, expectedAmountCents: 1_000, stripePaymentIntentId: "pi_live",
  stripeReaderOperationId: "tmr_live:pi_live", terminalReaderId: "reader-row", status: "WAITING_FOR_CUSTOMER",
};
const transaction = {
  id: transactionId, number: "POS-000001", totalCents: 1_000, customerEmail: "resident@example.com",
  stripePaymentIntentId: "pi_live", stripeChargeId: null, stripeReaderId: "tmr_live", stripeLocationId: "tml_live",
  paymentStatus: "PROCESSING", paymentMethod: null, paidAt: null,
};
const authoritativeReader = {
  id: "tmr_live", object: "terminal.reader" as const, livemode: true, location: "tml_live",
  action: { type: "process_payment_intent", status: "succeeded", process_payment_intent: { payment_intent: "pi_live" } },
};
const persistedReaderSuccess = {
  stripeEventId: "evt_reader_success", readerId: "tmr_live", locationId: "tml_live", liveMode: true,
  actionType: "process_payment_intent", actionStatus: "succeeded", stripePaymentIntentId: "pi_live",
  paymentAttemptId: attemptId, transactionId,
};

function verificationDb(rows: unknown[][]) {
  const results = [...rows];
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: vi.fn(async () => results.shift() ?? []) }) }) })),
  };
}

async function verify(overrides: {
  intent?: typeof successfulIntent;
  attempt?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  reader?: StripeReader | null;
  chargeOwner?: Record<string, unknown> | null;
  observation?: Record<string, unknown> | null;
} = {}) {
  const db = verificationDb([
    [{ ...attempt, ...overrides.attempt }],
    [{ ...transaction, ...overrides.transaction }],
    overrides.chargeOwner ? [overrides.chargeOwner] : [],
    overrides.observation ? [overrides.observation] : [],
  ]);
  return verifyTerminalPaymentForFinalization({
    db: db as never, env: env as never, transactionId, paymentAttemptId: attemptId,
    paymentIntent: overrides.intent ?? successfulIntent,
    authoritativeReader: overrides.reader === undefined ? authoritativeReader : overrides.reader,
  });
}

describe("paid transaction notification planning", () => {
  it("creates independent customer and management deliveries", () => {
    expect(buildPaidDeliveryRows({
      transactionId: "transaction-1",
      customerEmail: "resident@example.com",
      managementNotificationEmail: "management@example.com",
    })).toEqual([
      {
        transactionId: "transaction-1",
        kind: "RESIDENT_RECEIPT",
        recipientEmail: "resident@example.com",
        status: "PENDING",
      },
      {
        transactionId: "transaction-1",
        kind: "MANAGEMENT_PAYMENT_CONFIRMATION",
        recipientEmail: "management@example.com",
        status: "PENDING",
      },
    ]);
  });

  it("never blocks the customer receipt when management configuration is absent or invalid", () => {
    for (const managementNotificationEmail of [undefined, "invalid"]) {
      expect(buildPaidDeliveryRows({
        transactionId: "transaction-1",
        customerEmail: "resident@example.com",
        managementNotificationEmail,
      })).toHaveLength(1);
    }
  });
});

describe("Terminal success verification", () => {
  it("requires a concrete expanded successful Charge", async () => {
    await expect(verify({ intent: { ...successfulIntent, latest_charge: null } as never })).rejects.toThrow(/Charge evidence/u);
  });

  it("rejects an existing conflicting Charge and another transaction's Charge", async () => {
    await expect(verify({ transaction: { stripeChargeId: "ch_other" } })).rejects.toThrow(/different Stripe Charge/u);
    await expect(verify({ chargeOwner: { id: "another-transaction" } })).rejects.toThrow(/already owned/u);
  });

  it("accepts the exact existing Charge as an idempotent PAID identity", async () => {
    const result = await verify({
      transaction: { stripeChargeId: "ch_live", paymentStatus: "PAID", paymentMethod: "STRIPE_TERMINAL", paidAt: new Date() },
      chargeOwner: { id: transactionId },
    });
    expect(result.evidence.chargeId).toBe("ch_live");
  });

  it("rejects Charge evidence that belongs to another PaymentIntent or is not fully captured", async () => {
    await expect(verify({
      intent: { ...successfulIntent, latest_charge: { ...successfulIntent.latest_charge, payment_intent: "pi_other" } } as never,
    })).rejects.toThrow(/does not belong/u);
    await expect(verify({
      intent: { ...successfulIntent, latest_charge: { ...successfulIntent.latest_charge, amount_captured: 999 } } as never,
    })).rejects.toThrow(/not consistent/u);
  });

  it("rejects uncaptured and non-live Charge evidence", async () => {
    await expect(verify({
      intent: { ...successfulIntent, latest_charge: { ...successfulIntent.latest_charge, captured: false } } as never,
    })).rejects.toThrow(/not consistent/u);
    await expect(verify({
      intent: { ...successfulIntent, latest_charge: { ...successfulIntent.latest_charge, livemode: false } } as never,
    })).rejects.toThrow(/not consistent/u);
  });

  it("does not treat a local reader reservation as processing evidence", async () => {
    await expect(verify({
      attempt: { stripeReaderOperationId: null },
      transaction: { stripeReaderId: null, stripeLocationId: null },
      reader: null,
    })).rejects.toThrow(/reader evidence is unavailable/u);
  });

  it("rejects wrong authoritative reader and location identities", async () => {
    await expect(verify({ reader: { ...authoritativeReader, id: "tmr_wrong" } })).rejects.toThrow(/identity/u);
    await expect(verify({ reader: { ...authoritativeReader, location: "tml_wrong" } })).rejects.toThrow(/location/u);
  });

  it("rejects a test-mode Reader even when a persisted live observation exists", async () => {
    await expect(verify({
      reader: { ...authoritativeReader, livemode: false }, observation: persistedReaderSuccess,
    })).rejects.toThrow(/live-mode/u);
  });

  it("does not finalize without authoritative actual location evidence", async () => {
    await expect(verify({
      attempt: { stripeReaderOperationId: null },
      transaction: { stripeReaderId: null, stripeLocationId: null },
      reader: { ...authoritativeReader, location: null },
    })).rejects.toThrow(/location/u);
  });

  it("normalizes correct Stripe reader, location, Charge, and amount evidence", async () => {
    const result = await verify();
    expect(result.evidence).toMatchObject({
      paymentIntentId: "pi_live", chargeId: "ch_live", readerId: "tmr_live", locationId: "tml_live",
      amountReceived: 1_000, currency: "usd", paymentAttemptId: attemptId, transactionId,
      liveMode: true, paymentIntentStatus: "succeeded", readerActionStatus: "succeeded",
    });
  });

  it("does not treat durable operation or stored reader fields as completed processing evidence", async () => {
    await expect(verify({ reader: null })).rejects.toThrow(/reader evidence is unavailable/u);
  });

  it("waits when PaymentIntent success arrives before matching Reader success", async () => {
    const inProgressReader = {
      ...authoritativeReader,
      action: { ...authoritativeReader.action, status: "in_progress" },
    } as StripeReader;
    await expect(verify({ reader: inProgressReader })).rejects.toThrow(/reader evidence is unavailable/u);
  });

  it("uses persisted signed Reader success after the current action changes", async () => {
    const newerReader = {
      ...authoritativeReader,
      action: {
        type: "process_payment_intent", status: "in_progress",
        process_payment_intent: { payment_intent: "pi_newer" },
      },
    } as StripeReader;
    await expect(verify({ reader: newerReader, observation: persistedReaderSuccess }))
      .resolves.toMatchObject({ evidence: { readerId: "tmr_live", locationId: "tml_live" } });
  });

  it("uses persisted signed Reader success after the current Reader action becomes null", async () => {
    await expect(verify({
      reader: { ...authoritativeReader, action: null }, observation: persistedReaderSuccess,
    })).resolves.toMatchObject({ evidence: { readerActionStatus: "succeeded" } });
  });

  it("recovers completely from ephemeral Reader state using exact owned durable evidence", async () => {
    await expect(verify({ reader: null, observation: persistedReaderSuccess })).resolves.toMatchObject({
      evidence: {
        paymentIntentId: "pi_live", paymentAttemptId: attemptId, transactionId,
        readerId: "tmr_live", locationId: "tml_live", chargeId: "ch_live",
      },
    });
  });

  it("rejects persisted Reader evidence owned by another attempt or transaction", async () => {
    await expect(verify({
      reader: null,
      observation: { ...persistedReaderSuccess, paymentAttemptId: "another-attempt" },
    })).rejects.toThrow(/conflicts with this payment/u);
    await expect(verify({
      reader: null,
      observation: { ...persistedReaderSuccess, transactionId: "another-transaction" },
    })).rejects.toThrow(/conflicts with this payment/u);
  });
});

function finalizationDb(input: { attemptRows: unknown[]; transactionRows: unknown[]; reloadedAttempt?: unknown; reloadedTransaction?: unknown }) {
  const outerResults: unknown[][] = [[attempt], [transaction], []];
  const returningRows = [input.attemptRows, input.transactionRows];
  const reloadRows: unknown[][] = [];
  if (!input.attemptRows.length) reloadRows.push(input.reloadedAttempt ? [input.reloadedAttempt] : []);
  if (!input.transactionRows.length) reloadRows.push(input.reloadedTransaction ? [input.reloadedTransaction] : []);
  const tx = {
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: vi.fn(async () => returningRows.shift() ?? []) }) }) })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: vi.fn(async () => reloadRows.shift() ?? []) }) }) })),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: vi.fn(async () => undefined) }) })),
  };
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: vi.fn(async () => outerResults.shift() ?? []) }) }) })),
    transaction: vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)),
    tx,
  };
}

describe("conditional PAID finalization", () => {
  it("refuses an unexpected zero-row attempt update", async () => {
    const db = finalizationDb({ attemptRows: [], transactionRows: [], reloadedAttempt: { ...attempt, status: "CANCELED" } });
    await expect(reconcileTerminalPaymentSuccess({
      db: db as never, env: env as never, transactionId, paymentAttemptId: attemptId,
      paymentIntent: successfulIntent, authoritativeReader,
    })).rejects.toThrow(/attempt finalization affected no expected row/u);
  });

  it("refuses an unexpected zero-row transaction update", async () => {
    const db = finalizationDb({
      attemptRows: [{ id: attemptId }], transactionRows: [], reloadedTransaction: { ...transaction, paymentStatus: "CANCELED" },
    });
    await expect(reconcileTerminalPaymentSuccess({
      db: db as never, env: env as never, transactionId, paymentAttemptId: attemptId,
      paymentIntent: successfulIntent, authoritativeReader,
    })).rejects.toThrow(/Transaction finalization affected no expected row/u);
  });

  it("accepts zero-row updates only for the exact idempotent final state", async () => {
    const exactPaid = {
      ...transaction, paymentStatus: "PAID", paymentMethod: "STRIPE_TERMINAL", paidAt: new Date(), stripeChargeId: "ch_live",
    };
    const db = finalizationDb({
      attemptRows: [], transactionRows: [], reloadedAttempt: { ...attempt, status: "SUCCEEDED" }, reloadedTransaction: exactPaid,
    });
    const outerResults: unknown[][] = [[attempt], [exactPaid], [{ id: transactionId }]];
    db.select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: vi.fn(async () => outerResults.shift() ?? []) }) }) })) as never;
    await expect(reconcileTerminalPaymentSuccess({
      db: db as never, env: env as never, transactionId, paymentAttemptId: attemptId,
      paymentIntent: successfulIntent, authoritativeReader,
    })).resolves.toMatchObject({ chargeId: "ch_live" });
    expect(db.tx.insert).toHaveBeenCalledOnce();
  });

  it("converges concurrent successful reconciliation onto one PAID state and one set of delivery rows", async () => {
    let currentAttempt = { ...attempt };
    let currentTransaction = { ...transaction };
    let deliveriesInserted = false;
    let logicalDeliveryInsertCount = 0;
    const db = {
      select: vi.fn((fields?: unknown) => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: vi.fn(async () => {
              if (table === (await import("@/db/schema")).paymentAttempts) return [currentAttempt];
              if (fields) return [];
              return [currentTransaction];
            }),
          }),
        }),
      })),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback({
        update: vi.fn((table: unknown) => ({ set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: vi.fn(async () => {
              const schema = await import("@/db/schema");
              if (table === schema.paymentAttempts) {
                currentAttempt = { ...currentAttempt, ...values };
                return [{ id: attemptId }];
              }
              if (table === schema.transactions) {
                if (currentTransaction.paymentStatus === "PAID") return [];
                currentTransaction = { ...currentTransaction, ...values };
                return [{ id: transactionId }];
              }
              return [];
            }),
          }),
        }) })),
        select: vi.fn(() => ({ from: () => ({ where: () => ({
          limit: vi.fn(async () => currentAttempt.status === "SUCCEEDED" && currentTransaction.paymentStatus !== "PAID"
            ? [currentAttempt]
            : [currentTransaction]),
        }) }) })),
        insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: vi.fn(async () => {
          if (!deliveriesInserted) {
            deliveriesInserted = true;
            logicalDeliveryInsertCount += 1;
          }
        }) }) })),
      } as never)),
    };
    const results = await Promise.all([
      reconcileTerminalPaymentSuccess({
        db: db as never, env: env as never, transactionId, paymentAttemptId: attemptId,
        paymentIntent: successfulIntent, authoritativeReader,
      }),
      reconcileTerminalPaymentSuccess({
        db: db as never, env: env as never, transactionId, paymentAttemptId: attemptId,
        paymentIntent: successfulIntent, authoritativeReader,
      }),
    ]);
    expect(results).toHaveLength(2);
    expect(currentAttempt.status).toBe("SUCCEEDED");
    expect(currentTransaction.paymentStatus).toBe("PAID");
    expect(logicalDeliveryInsertCount).toBe(1);
  });
});

describe("failure transition safety", () => {
  it("never downgrades a SUCCEEDED attempt or PAID transaction", async () => {
    const update = vi.fn(() => ({
      set: () => ({ where: () => ({ returning: vi.fn(async () => []) }) }),
    }));
    const tx = {
      update,
      select: vi.fn()
        .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: vi.fn(async () => [{ ...transaction, paymentStatus: "PAID" }]) }) }) }),
    };
    const db = { transaction: vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)) };
    await markPaymentFailed({
      db: db as never, transactionId, paymentAttemptId: attemptId, code: "delayed_failure", message: "late event",
    });
    expect(update).not.toHaveBeenCalled();
  });
});
