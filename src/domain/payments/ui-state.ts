export function paymentActivationUi(input: {
  hasActiveTransaction: boolean;
  paymentStatus: string;
  readerDisplayPending: boolean;
}) {
  const active = ["SENDING_TO_TERMINAL", "READY", "WAITING_FOR_CUSTOMER", "PROCESSING"].includes(input.paymentStatus) || input.readerDisplayPending;
  return {
    activationAllowed: !input.hasActiveTransaction,
    readyToStart: false,
    active,
  };
}

export function paymentPhaseLabel(paymentStatus: string, completed: boolean) {
  if (completed || paymentStatus === "PAID") return "Payment successful";
  if (["SENDING_TO_TERMINAL", "READY"].includes(paymentStatus)) return "Preparing terminal";
  if (paymentStatus === "WAITING_FOR_CUSTOMER") return "Waiting for card";
  if (paymentStatus === "PROCESSING") return "Processing payment";
  if (paymentStatus === "FAILED") return "Payment declined";
  return "Reviewing items";
}
