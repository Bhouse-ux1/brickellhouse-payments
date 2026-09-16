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

export function nextEmployeePaymentStatus(current: string, incoming: string) {
  if (["PAID", "CANCELED"].includes(current)) return current;
  const order: Record<string, number> = { DRAFT: 0, SENDING_TO_TERMINAL: 1, READY: 1, WAITING_FOR_CUSTOMER: 2, PROCESSING: 3 };
  if (order[current] !== undefined && order[incoming] !== undefined && order[incoming] < order[current]) return current;
  return incoming;
}

export function cancellationCompleted(responseOk: boolean, paymentStatus: string | undefined) {
  return responseOk && paymentStatus === "CANCELED";
}
