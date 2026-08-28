import { describe, expect, it, vi } from "vitest";
import { decideExistingPaymentIntentAction, runAfterTrustedReaderDisplay } from "./terminal-payment";

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

  it("never creates or processes a payment when the trusted reader display fails", async () => {
    const proceed = vi.fn(async () => "payment action");
    await expect(runAfterTrustedReaderDisplay({
      confirmDisplay: async () => { throw new Error("display failed"); },
      proceed,
    })).rejects.toThrow(/display failed/u);
    expect(proceed).not.toHaveBeenCalled();
  });
});
