import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const terminalSource = readFileSync(new URL("./terminal-payment.ts", import.meta.url), "utf8");
const webhookSource = readFileSync(new URL("./stripe-reconciliation.ts", import.meta.url), "utf8");

describe("shared Terminal success gate wiring", () => {
  it("routes polling and browser refresh success through the shared gate", () => {
    expect(terminalSource).toContain("await reconcileTerminalPaymentSuccess({");
    expect(terminalSource).not.toContain("markPaymentSucceeded");
  });

  it("routes retry success through the shared gate", () => {
    expect(terminalSource).toMatch(/RECONCILE_SUCCESS[\s\S]+reconcileTerminalPaymentSuccess/u);
  });

  it("routes cancellation recovery success through the shared gate", () => {
    const cancellationSource = terminalSource.slice(terminalSource.indexOf("export async function cancelTerminalPayment"));
    expect(cancellationSource.match(/reconcileTerminalPaymentSuccess/g)).toHaveLength(2);
  });

  it("routes webhook success through the same shared gate", () => {
    expect(webhookSource).toContain("input.finalizeSucceeded ?? reconcileTerminalPaymentSuccess");
    expect(webhookSource).not.toContain("markPaymentSucceeded");
  });

  it("keeps the low-level PAID finalizer private to the verified evidence module", () => {
    expect(terminalSource).not.toContain("finalizeVerifiedTerminalPayment");
    expect(webhookSource).not.toContain("finalizeVerifiedTerminalPayment");
  });
});
