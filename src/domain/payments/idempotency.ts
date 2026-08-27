export function buildPaymentAttemptIdempotencyKey(transactionId: string, attemptNumber: number) {
  if (!transactionId || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("Invalid payment attempt identity.");
  return `brickellhouse:${transactionId}:attempt:${attemptNumber}`;
}

export type ReaderReservationDecision = "ACQUIRE" | "RESUME" | "BUSY";

export function decideReaderReservation(input: {
  requestedAttemptId: string;
  lockedAttemptId: string | null;
  lockExpiresAt: Date | null;
  now: Date;
}): ReaderReservationDecision {
  if (input.lockedAttemptId === input.requestedAttemptId) return "RESUME";
  if (input.lockedAttemptId && input.lockExpiresAt && input.lockExpiresAt.getTime() > input.now.getTime()) return "BUSY";
  return "ACQUIRE";
}
