import { describe, expect, it } from "vitest";
import { cancellationCompleted, nextEmployeePaymentStatus, paymentActivationUi, paymentPhaseLabel } from "./ui-state";

describe("employee Terminal payment state", () => {
  it("rejects stale preparation/waiting responses after newer processing or terminal states", () => {
    expect(nextEmployeePaymentStatus("PROCESSING", "WAITING_FOR_CUSTOMER")).toBe("PROCESSING");
    expect(nextEmployeePaymentStatus("PAID", "SENDING_TO_TERMINAL")).toBe("PAID");
    expect(nextEmployeePaymentStatus("CANCELED", "WAITING_FOR_CUSTOMER")).toBe("CANCELED");
    expect(cancellationCompleted(true, "SENDING_TO_TERMINAL")).toBe(false);
    expect(cancellationCompleted(false, "CANCELED")).toBe(false);
    expect(cancellationCompleted(true, "CANCELED")).toBe(true);
  });
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
