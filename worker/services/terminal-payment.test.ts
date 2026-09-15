import { describe, expect, it, vi } from "vitest";
import { paymentAttempts, transactions } from "@/db/schema";
import {
  classifyReaderAction, decideExistingPaymentIntentAction, decidePolledPaymentReconciliation,
  decideReaderDisplayRecovery, processAfterPaymentIntentPersistence, READER_DISPLAY_TIMEOUT_MS,
  shouldDeferUnstartedPaymentReconciliation, shouldRecoverExpiredIdleReservation, shouldReplayUnrecordedReaderProcess,
} from "./terminal-payment";

describe("Terminal payment recovery", () => {
  it("does not process a duplicate Charge click while the reader is active", () => {
    expect(decideExistingPaymentIntentAction({
      attemptStatus: "WAITING_FOR_CUSTOMER", paymentIntentStatus: "requires_payment_method",
      readerAction: "PAYMENT_ACTIVE", readerPaymentIntentMatches: true, hasReaderOperation: true,
    })).toBe("SHOW_WAITING");
    expect(decideExistingPaymentIntentAction({
      attemptStatus: "PROCESSING", paymentIntentStatus: "processing",
      readerAction: "PAYMENT_ACTIVE", readerPaymentIntentMatches: true, hasReaderOperation: true,
    })).toBe("SHOW_PROCESSING");
  });

  it("recovers the same PaymentIntent after browser refresh", () => {
    expect(decideExistingPaymentIntentAction({
      attemptStatus: "SENT_TO_READER", paymentIntentStatus: "requires_payment_method",
      readerAction: "PAYMENT_ACTIVE", readerPaymentIntentMatches: true, hasReaderOperation: false,
    })).toBe("SHOW_WAITING");
  });

  it("does not restart a definitively failed attempt", () => {
    expect(decideExistingPaymentIntentAction({
      attemptStatus: "FAILED", paymentIntentStatus: "requires_payment_method",
      readerAction: "IDLE", readerPaymentIntentMatches: false, hasReaderOperation: true,
    })).toBe("SHOW_FAILED");
  });

  it("reconciles success instead of starting another reader action", () => {
    expect(decideExistingPaymentIntentAction({
      attemptStatus: "PROCESSING", paymentIntentStatus: "succeeded",
      readerAction: "IDLE", readerPaymentIntentMatches: false, hasReaderOperation: true,
    })).toBe("RECONCILE_SUCCESS");
  });

  it("recognizes the S710's in-progress cart as a display-only action", () => {
    const reader = {
      id: "tmr_live", object: "terminal.reader" as const, livemode: true, location: "tml_live",
      action: { type: "set_reader_display", status: "in_progress" },
    };
    expect(classifyReaderAction(reader)).toBe("CART_DISPLAY");
    expect(READER_DISPLAY_TIMEOUT_MS).toBe(120_000);
  });

  it("never classifies a PaymentIntent reader action as safe to clear", () => {
    const reader = {
      id: "tmr_live", object: "terminal.reader" as const, livemode: true, location: "tml_live",
      action: { type: "process_payment_intent", status: "in_progress", process_payment_intent: { payment_intent: "pi_live" } },
    };
    expect(classifyReaderAction(reader)).toBe("PAYMENT_ACTIVE");
  });

  it("does not treat Stripe's retained completed reader action as still active", () => {
    const reader = {
      id: "tmr_live", object: "terminal.reader" as const, livemode: true, location: "tml_live",
      action: { type: "process_payment_intent", status: "succeeded", process_payment_intent: { payment_intent: "pi_previous" } },
    };
    expect(classifyReaderAction(reader)).toBe("IDLE");
  });

  it("stores at most one PaymentIntent and reader-operation identity per attempt", () => {
    expect(paymentAttempts.idempotencyKey.isUnique).toBe(true);
    expect(paymentAttempts.stripePaymentIntentId.isUnique).toBe(true);
    expect(paymentAttempts.stripeReaderOperationId.isUnique).toBe(true);
    expect(transactions.stripePaymentIntentId.isUnique).toBe(true);
    expect(transactions.stripeChargeId.isUnique).toBe(true);
  });

  it("never begins reader processing until durable PaymentIntent persistence is confirmed", async () => {
    const sequence: string[] = [];
    const result = await processAfterPaymentIntentPersistence({
      confirmPersisted: async () => { sequence.push("persisted"); },
      processPaymentIntent: async () => { sequence.push("processed"); return "reader-action"; },
    });
    expect(sequence).toEqual(["persisted", "processed"]);
    expect(result).toBe("reader-action");
  });

  it("replays only an unrecorded process transition with the same PaymentIntent and idempotency key", () => {
    const transition = {
      attemptStatus: "SENT_TO_READER" as const,
      lastErrorCode: "READER_PROCESS_STARTING",
      hasReaderOperation: false,
      paymentIntentStatus: "requires_payment_method",
      readerAction: "CART_DISPLAY" as const,
    };
    expect(shouldReplayUnrecordedReaderProcess(transition)).toBe(true);
    expect(shouldReplayUnrecordedReaderProcess({ ...transition, hasReaderOperation: true })).toBe(false);
    expect(shouldReplayUnrecordedReaderProcess({ ...transition, readerAction: "PAYMENT_ACTIVE" })).toBe(false);
  });

  it("does not let polling cancel a fresh one-click preparation before its PaymentIntent is mapped", () => {
    const now = new Date("2026-09-15T18:36:24.500Z");
    expect(shouldDeferUnstartedPaymentReconciliation({
      attemptStatus: "READER_RESERVED",
      attemptUpdatedAt: new Date("2026-09-15T18:36:24.000Z"),
      now,
    })).toBe(true);
    expect(shouldDeferUnstartedPaymentReconciliation({
      attemptStatus: "READER_RESERVED",
      attemptUpdatedAt: new Date(now.getTime() - READER_DISPLAY_TIMEOUT_MS),
      now,
    })).toBe(false);
  });

  it("does not call process_payment_intent when persistence confirmation fails", async () => {
    const processPaymentIntent = vi.fn(async () => "reader-action");
    await expect(processAfterPaymentIntentPersistence({
      confirmPersisted: async () => { throw new Error("database unavailable"); },
      processPaymentIntent,
    })).rejects.toThrow(/database unavailable/u);
    expect(processPaymentIntent).not.toHaveBeenCalled();
  });

  it("releases an orphan only after Stripe confirms idle and refuses uncertain payment state", () => {
    expect(decideReaderDisplayRecovery({ readerAction: "IDLE", hasPaymentIntent: false })).toBe("RELEASE_CONFIRMED_IDLE");
    expect(decideReaderDisplayRecovery({ readerAction: "CART_DISPLAY", hasPaymentIntent: false })).toBe("CLEAR_VERIFIED_CART");
    expect(decideReaderDisplayRecovery({ readerAction: "IDLE", hasPaymentIntent: true })).toBe("REFUSE_UNCERTAIN");
    expect(decideReaderDisplayRecovery({ readerAction: "PAYMENT_ACTIVE", hasPaymentIntent: false })).toBe("REFUSE_UNCERTAIN");
    expect(decideReaderDisplayRecovery({ readerAction: "UNCERTAIN", hasPaymentIntent: false })).toBe("REFUSE_UNCERTAIN");
  });

  it("recovers only an expired, idle, PaymentIntent-free database reservation", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const safe = {
      lockExpiresAt: new Date("2026-09-14T11:59:00Z"),
      now,
      readerAction: "IDLE" as const,
      attemptStatus: "READER_RESERVED" as const,
      hasPaymentIntent: false,
      hasReaderOperation: false,
    };
    expect(shouldRecoverExpiredIdleReservation(safe)).toBe(true);
    expect(shouldRecoverExpiredIdleReservation({ ...safe, lockExpiresAt: new Date("2026-09-14T12:01:00Z") })).toBe(false);
    expect(shouldRecoverExpiredIdleReservation({ ...safe, readerAction: "PAYMENT_ACTIVE" })).toBe(false);
    expect(shouldRecoverExpiredIdleReservation({ ...safe, hasPaymentIntent: true })).toBe(false);
    expect(shouldRecoverExpiredIdleReservation({ ...safe, hasReaderOperation: true })).toBe(false);
  });

  it("finalizes only an exact succeeded PaymentIntent during polling", () => {
    const base = {
      paymentIntentStatus: "succeeded",
      amountReceived: 51,
      expectedAmountCents: 51,
      readerAction: "IDLE" as const,
      readerActionStatus: null,
      readerPaymentIntentMatches: false,
      readerFailureCode: null,
      attemptStatus: "WAITING_FOR_CUSTOMER" as const,
    };
    expect(decidePolledPaymentReconciliation(base)).toBe("SUCCEEDED");
    expect(decidePolledPaymentReconciliation({ ...base, amountReceived: 50 })).toBe("UNCERTAIN");
  });

  it("keeps an active reader action waiting and releases only definitive endings", () => {
    const active = {
      paymentIntentStatus: "requires_payment_method",
      expectedAmountCents: 51,
      readerAction: "PAYMENT_ACTIVE" as const,
      readerActionStatus: "in_progress",
      readerPaymentIntentMatches: true,
      readerFailureCode: null,
      attemptStatus: "WAITING_FOR_CUSTOMER" as const,
    };
    expect(decidePolledPaymentReconciliation(active)).toBe("WAITING");
    expect(decidePolledPaymentReconciliation({ ...active, readerActionStatus: "failed", readerFailureCode: "card_declined" })).toBe("FAILED");
    expect(decidePolledPaymentReconciliation({ ...active, readerActionStatus: "failed", readerFailureCode: "customer_canceled" })).toBe("CANCELED");
    expect(decidePolledPaymentReconciliation({ ...active, readerAction: "UNCERTAIN", readerPaymentIntentMatches: false })).toBe("UNCERTAIN");
  });

  it("recovers a refresh with an idle, not-yet-processed PaymentIntent without creating another one", () => {
    expect(decidePolledPaymentReconciliation({
      paymentIntentStatus: "requires_payment_method",
      expectedAmountCents: 51,
      readerAction: "IDLE",
      readerActionStatus: null,
      readerPaymentIntentMatches: false,
      readerFailureCode: null,
      attemptStatus: "PAYMENT_INTENT_CREATED",
    })).toBe("READY");
  });
});
