export const employeePaymentStatus = {
  DRAFT: "Ready",
  READY: "Ready",
  SENDING_TO_TERMINAL: "Review the details on the S710. Card is not ready yet—then press Start card payment",
  WAITING_FOR_CUSTOMER: "S710 ready—tap, insert, or swipe once",
  PROCESSING: "Processing payment",
  PAID: "Payment successful",
  FAILED: "Payment declined",
  CANCELED: "Payment canceled",
  TERMINAL_BUSY: "Terminal currently in use",
  TERMINAL_OFFLINE: "Terminal unavailable",
} as const;

export type PaymentStatus = keyof typeof employeePaymentStatus;
