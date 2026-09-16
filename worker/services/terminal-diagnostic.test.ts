import { describe, expect, it, vi } from "vitest";
import { paymentAttempts, stripeEvents, terminalReaderObservations, terminalReaders, transactionItems, transactions } from "@/db/schema";
import { readTerminalDiagnostic, safeDiagnosticResult } from "./terminal-diagnostic";

const base: Parameters<typeof safeDiagnosticResult>[0] = {
  reader: { id: "tmr_live", object: "terminal.reader", status: "online", livemode: true, location: "tml_live", action: { type: "set_reader_display", status: "in_progress" } },
  intent: { id: "pi_live", object: "payment_intent", status: "requires_payment_method", amount: 71, amount_received: 0, currency: "usd", livemode: true, metadata: {}, payment_method: null, latest_charge: null },
  transactionStatus: "SENDING_TO_TERMINAL", attemptStatus: "READER_RESERVED",
  identityAndAmountMatch: true, readerMatches: true, cartMatches: true, mappingMatches: true, reservationOwned: true,
  hasRecordedOperation: false, hasRecordedCharge: false, hasPaidAt: false, hasNonfailedObservation: false, databaseChanged: false,
};

describe("read-only diagnostic decisions and disclosure", () => {
  it("identifies verified pre-card state only as a candidate requiring a fresh check", () => {
    expect(safeDiagnosticResult(base).decision).toBe("PRE_CARD_CANCEL_CANDIDATE_RECHECK_BEFORE_ANY_ACTION");
  });
  it.each([
    { identityAndAmountMatch: false }, { readerMatches: false }, { mappingMatches: false },
    { databaseChanged: true }, { reservationOwned: false }, { hasNonfailedObservation: true },
    { hasRecordedOperation: true }, { hasRecordedCharge: true },
    { intent: { ...base.intent!, payment_method: "pm_private" } },
    { intent: { ...base.intent!, latest_charge: "ch_private" } },
    { intent: { ...base.intent!, amount_received: 1 } },
    { reader: { ...base.reader, status: "offline" } },
  ])("fails closed for mismatches, changing state, or payment evidence: %s", override => {
    expect(safeDiagnosticResult({ ...base, ...override }).decision).toBe("RECONCILIATION_REQUIRED");
  });
  it("never mistakes succeeded or processing for safely cancelable", () => {
    expect(safeDiagnosticResult({ ...base, intent: { ...base.intent!, status: "succeeded" } }).decision).toBe("SUCCESS_REQUIRES_EXISTING_STRICT_FINALIZATION");
    expect(safeDiagnosticResult({ ...base, intent: { ...base.intent!, status: "processing" } }).decision).toBe("PAYMENT_ACTIVE");
  });
  it("returns no raw Stripe identifiers, secrets, metadata, card details, or provider strings", () => {
    const result = safeDiagnosticResult({ ...base,
      reader: { ...base.reader, action: { type: "private-provider-value", status: "private-provider-value", failure_message: "private-provider-value" } },
      intent: { ...base.intent!, payment_method: { secret: "private-provider-value" }, latest_charge: { id: "ch_private", payment_method_details: { card_present: { last4: "1234" } } }, client_secret: "private-provider-value", metadata: { secret: "private-provider-value" } } as typeof base.intent,
    });
    const json = JSON.stringify(result);
    for (const value of ["private-provider-value", "client_secret", "1234", "pi_live", "tmr_live", "ch_private", "metadata", "authorization"]) expect(json).not.toContain(value);
    expect(result.paymentIntent.paymentMethodExists).toBe(true);
    expect(result.paymentIntent.latestChargeExists).toBe(true);
  });
  it("uses a read-only database transaction and exactly two Stripe GETs", async () => {
    const id = "3971ba79-1704-4e95-a189-2857847a3075";
    const attemptId = "c6e7f64f-b300-41b4-bba9-2eb0cf00d408";
    const now = new Date();
    const rows = new Map<unknown, unknown[]>([
      [transactions, [{ id, number: "POS-000026", paymentStatus: "SENDING_TO_TERMINAL", totalCents: 71, stripePaymentIntentId: "pi_live" }]],
      [paymentAttempts, [{ id: attemptId, transactionId: id, status: "READER_RESERVED", terminalReaderId: "reader", expectedAmountCents: 71, stripePaymentIntentId: "pi_live", createdAt: now, updatedAt: now }]],
      [terminalReaders, [{ id: "reader", active: true, stripeLocationId: "tml_live", lockPaymentAttemptId: attemptId }]],
      [transactionItems, []], [terminalReaderObservations, []], [stripeEvents, []],
    ]);
    const tx = { select: () => ({ from: (table: unknown) => {
      const result = rows.get(table) ?? [];
      const query = { where: () => query, limit: () => Promise.resolve(result), orderBy: () => query, then: Promise.resolve(result).then.bind(Promise.resolve(result)) };
      return query;
    } }) };
    const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const body = String(url).includes("/terminal/readers/") ? base.reader : { ...base.intent!, payment_method_types: ["card_present"], metadata: { source: "brickellhouse_terminal", attempt_id: attemptId, internal_transaction_id: id, transaction_number: "POS-000026" } };
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await readTerminalDiagnostic({ transaction } as never, { STRIPE_SECRET_KEY: "rk_live_placeholder", STRIPE_LIVE_MODE_ONLY: "true", STRIPE_TERMINAL_READER_ID: "tmr_live", STRIPE_TERMINAL_LOCATION_ID: "tml_live" });
      expect(result.transactionReference).toBe("POS-000026");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), { accessMode: "read only", isolationLevel: "read committed" });
    } finally { vi.unstubAllGlobals(); }
  });
});
