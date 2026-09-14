import { describe, expect, it } from "vitest";
import { buildPaymentAttemptIdempotencyKey, buildReaderProcessIdempotencyKey, decideReaderReservation } from "./idempotency";

describe("payment idempotency", () => {
  it("returns the same key for the same logical attempt", () => {
    expect(buildPaymentAttemptIdempotencyKey("txn-1", 1)).toBe("brickellhouse:txn-1:attempt:1");
    expect(buildReaderProcessIdempotencyKey(buildPaymentAttemptIdempotencyKey("txn-1", 1))).toBe("brickellhouse:txn-1:attempt:1:reader");
    expect(buildReaderProcessIdempotencyKey(buildPaymentAttemptIdempotencyKey("txn-1", 1))).toBe("brickellhouse:txn-1:attempt:1:reader");
    expect(buildPaymentAttemptIdempotencyKey("txn-1", 1)).toBe("brickellhouse:txn-1:attempt:1");
  });
  it("resumes its own reader reservation", () => {
    expect(decideReaderReservation({ requestedAttemptId: "a", lockedAttemptId: "a", lockExpiresAt: new Date(Date.now() + 1000), now: new Date() })).toBe("RESUME");
  });
  it("never takes another attempt's lock based only on elapsed time", () => {
    const now = new Date("2026-08-26T12:00:00Z");
    expect(decideReaderReservation({ requestedAttemptId: "b", lockedAttemptId: "a", lockExpiresAt: new Date("2026-08-26T12:01:00Z"), now })).toBe("BUSY");
    expect(decideReaderReservation({ requestedAttemptId: "b", lockedAttemptId: "a", lockExpiresAt: new Date("2026-08-26T11:59:00Z"), now })).toBe("BUSY");
    expect(decideReaderReservation({ requestedAttemptId: "b", lockedAttemptId: null, lockExpiresAt: null, now })).toBe("ACQUIRE");
  });
});
