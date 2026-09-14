export function paymentActivationUi(input: {
  hasActiveTransaction: boolean;
  paymentStatus: string;
  readerDisplayPending: boolean;
}) {
  const readyToStart = input.readerDisplayPending || ["READY", "FAILED"].includes(input.paymentStatus);
  const active = ["WAITING_FOR_CUSTOMER", "PROCESSING"].includes(input.paymentStatus);
  return {
    activationAllowed: !input.hasActiveTransaction || readyToStart,
    readyToStart,
    active,
  };
}

export function paymentPhaseLabel(paymentStatus: string, completed: boolean) {
  if (completed || paymentStatus === "PAID") return "Payment successful";
  if (["SENDING_TO_TERMINAL", "READY"].includes(paymentStatus)) return "Ready to start card payment";
  if (paymentStatus === "WAITING_FOR_CUSTOMER") return "Waiting for card";
  if (paymentStatus === "PROCESSING") return "Processing payment";
  if (paymentStatus === "FAILED") return "Payment declined";
  return "Reviewing items";
}
