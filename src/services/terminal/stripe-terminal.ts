export type TerminalPaymentRequest = { paymentAttemptId: string; amountCents: number; currency: "usd" };
export type TerminalPaymentResult = { ok: false; code: "TERMINAL_NOT_ENABLED" } | { ok: true; stripePaymentIntentId: string; readerOperationId: string };
export interface TerminalPaymentGateway { beginPayment(request: TerminalPaymentRequest): Promise<TerminalPaymentResult> }
export class DisabledTerminalPaymentGateway implements TerminalPaymentGateway {
  async beginPayment(): Promise<TerminalPaymentResult> { return { ok: false, code: "TERMINAL_NOT_ENABLED" }; }
}
export const terminalPaymentGateway: TerminalPaymentGateway = new DisabledTerminalPaymentGateway();
