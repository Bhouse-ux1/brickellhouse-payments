import { describe, expect, it } from "vitest";
import { paymentActivationUi, paymentPhaseLabel } from "./ui-state";

describe("employee Terminal payment state", () => {
  it("treats the informational cart as review-only until Start card payment", () => {
    const state = paymentActivationUi({
      hasActiveTransaction: true,
      paymentStatus: "SENDING_TO_TERMINAL",
      readerDisplayPending: true,
    });
    expect(state).toEqual({ activationAllowed: true, readyToStart: true, active: false });
    expect(paymentPhaseLabel("SENDING_TO_TERMINAL", false)).toBe("Ready to start card payment");
  });

  it("blocks duplicate activation while waiting for a card or processing", () => {
    for (const paymentStatus of ["WAITING_FOR_CUSTOMER", "PROCESSING"]) {
      const state = paymentActivationUi({ hasActiveTransaction: true, paymentStatus, readerDisplayPending: false });
      expect(state.activationAllowed).toBe(false);
      expect(state.active).toBe(true);
    }
  });

  it("shows the trusted paid state as successful", () => {
    expect(paymentPhaseLabel("PAID", true)).toBe("Payment successful");
  });

  it("allows a definitive decline to retry the same idempotent PaymentIntent", () => {
    expect(paymentActivationUi({
      hasActiveTransaction: true,
      paymentStatus: "FAILED",
      readerDisplayPending: false,
    }).activationAllowed).toBe(true);
    expect(paymentPhaseLabel("FAILED", false)).toBe("Payment declined");
  });
});
