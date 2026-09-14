export function buildPaymentAttemptIdempotencyKey(transactionId: string, attemptNumber: number) {
  if (!transactionId || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("Invalid payment attempt identity.");
  return `brickellhouse:${transactionId}:attempt:${attemptNumber}`;
}

export function buildReaderProcessIdempotencyKey(paymentAttemptIdempotencyKey: string) {
  if (!paymentAttemptIdempotencyKey) throw new Error("Invalid reader process identity.");
  return `${paymentAttemptIdempotencyKey}:reader`;
}

export type ReaderReservationDecision = "ACQUIRE" | "RESUME" | "BUSY";

export function decideReaderReservation(input: {
  requestedAttemptId: string;
  lockedAttemptId: string | null;
  lockExpiresAt: Date | null;
  now: Date;
}): ReaderReservationDecision {
  if (input.lockedAttemptId === input.requestedAttemptId) return "RESUME";
  // Expiration is diagnostic only. A different lock is never replaced until
  // Stripe and the linked PaymentIntent have been independently reconciled.
  if (input.lockedAttemptId) return "BUSY";
  return "ACQUIRE";
}
