export const employeePaymentStatus = {
  DRAFT: "Ready",
  READY: "Preparing terminal",
  SENDING_TO_TERMINAL: "Preparing terminal",
  WAITING_FOR_CUSTOMER: "Waiting for card. Ask the resident to tap, insert, or swipe once.",
  PROCESSING: "Processing payment",
  PAID: "Payment successful",
  FAILED: "Payment declined",
  CANCELED: "Payment canceled",
  TERMINAL_BUSY: "Terminal currently in use",
  TERMINAL_OFFLINE: "Terminal unavailable",
} as const;

export type PaymentStatus = keyof typeof employeePaymentStatus;
