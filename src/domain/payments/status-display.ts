export const employeePaymentStatus = {
  DRAFT: "Ready",
  READY: "Ready",
  SENDING_TO_TERMINAL: "Review the payment details on the S710, then start card payment",
  WAITING_FOR_CUSTOMER: "Waiting for payment",
  PROCESSING: "Processing payment",
  PAID: "Payment successful",
  FAILED: "Payment declined",
  CANCELED: "Payment canceled",
  TERMINAL_BUSY: "Terminal currently in use",
  TERMINAL_OFFLINE: "Terminal unavailable",
} as const;

export type PaymentStatus = keyof typeof employeePaymentStatus;
