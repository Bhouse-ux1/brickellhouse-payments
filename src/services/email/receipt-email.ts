export type ReceiptEmailRequest = { transactionId: string; recipientEmail: string };
export type ReceiptEmailResult = { ok: false; code: "EMAIL_NOT_ENABLED" } | { ok: true; providerMessageId: string };
export interface ReceiptEmailGateway { sendVerifiedPaymentReceipt(request: ReceiptEmailRequest): Promise<ReceiptEmailResult> }
export class DisabledReceiptEmailGateway implements ReceiptEmailGateway {
  async sendVerifiedPaymentReceipt(): Promise<ReceiptEmailResult> { return { ok: false, code: "EMAIL_NOT_ENABLED" }; }
}
export const receiptEmailGateway: ReceiptEmailGateway = new DisabledReceiptEmailGateway();
