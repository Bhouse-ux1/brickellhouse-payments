import { describe, expect, it } from "vitest";
import { paymentActivationUi, paymentPhaseLabel } from "./ui-state";

describe("employee Terminal payment state", () => {
  it("keeps the one-click flow active while the cart and reader are prepared", () => {
    const state = paymentActivationUi({
      hasActiveTransaction: true,
      paymentStatus: "SENDING_TO_TERMINAL",
      readerDisplayPending: true,
    });
    expect(state).toEqual({ activationAllowed: false, readyToStart: false, active: true });
    expect(paymentPhaseLabel("SENDING_TO_TERMINAL", false)).toBe("Preparing terminal");
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

  it("does not expose a second activation after a definitive decline", () => {
    expect(paymentActivationUi({
      hasActiveTransaction: true,
      paymentStatus: "FAILED",
      readerDisplayPending: false,
    }).activationAllowed).toBe(false);
    expect(paymentPhaseLabel("FAILED", false)).toBe("Payment declined");
  });
});
