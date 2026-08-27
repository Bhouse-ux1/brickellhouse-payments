import { describe, expect, it } from "vitest";
import { buildPaymentAttemptIdempotencyKey, decideReaderReservation } from "./idempotency";

describe("payment idempotency", () => {
  it("returns the same key for the same logical attempt", () => {
    expect(buildPaymentAttemptIdempotencyKey("txn-1", 1)).toBe("brickellhouse:txn-1:attempt:1");
    expect(buildPaymentAttemptIdempotencyKey("txn-1", 1)).toBe("brickellhouse:txn-1:attempt:1");
  });
  it("resumes its own reader reservation", () => {
    expect(decideReaderReservation({ requestedAttemptId: "a", lockedAttemptId: "a", lockExpiresAt: new Date(Date.now() + 1000), now: new Date() })).toBe("RESUME");
  });
  it("blocks another active attempt and recovers an expired lock", () => {
    const now = new Date("2026-08-26T12:00:00Z");
    expect(decideReaderReservation({ requestedAttemptId: "b", lockedAttemptId: "a", lockExpiresAt: new Date("2026-08-26T12:01:00Z"), now })).toBe("BUSY");
    expect(decideReaderReservation({ requestedAttemptId: "b", lockedAttemptId: "a", lockExpiresAt: new Date("2026-08-26T11:59:00Z"), now })).toBe("ACQUIRE");
  });
});
