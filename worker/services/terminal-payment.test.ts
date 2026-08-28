import { describe, expect, it } from "vitest";
import { classifyReaderAction, decideExistingPaymentIntentAction, READER_DISPLAY_TIMEOUT_MS } from "./terminal-payment";

describe("Terminal payment recovery", () => {
  it("does not process a duplicate Charge click while the reader is active", () => {
    expect(decideExistingPaymentIntentAction({ attemptStatus: "WAITING_FOR_CUSTOMER", paymentIntentStatus: "requires_payment_method" })).toBe("SHOW_WAITING");
    expect(decideExistingPaymentIntentAction({ attemptStatus: "PROCESSING", paymentIntentStatus: "processing" })).toBe("SHOW_PROCESSING");
  });

  it("recovers the same PaymentIntent after browser refresh", () => {
    expect(decideExistingPaymentIntentAction({ attemptStatus: "SENT_TO_READER", paymentIntentStatus: "requires_payment_method" })).toBe("SHOW_WAITING");
  });

  it("reuses a declined PaymentIntent when Stripe returns it to requires_payment_method", () => {
    expect(decideExistingPaymentIntentAction({ attemptStatus: "FAILED", paymentIntentStatus: "requires_payment_method" })).toBe("PROCESS_REUSING_INTENT");
  });

  it("reconciles success instead of starting another reader action", () => {
    expect(decideExistingPaymentIntentAction({ attemptStatus: "PROCESSING", paymentIntentStatus: "succeeded" })).toBe("RECONCILE_SUCCESS");
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
});
