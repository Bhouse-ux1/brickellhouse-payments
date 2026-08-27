import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { terminalReaders } from "@/db/schema";
import { decideReaderReservation } from "@/domain/payments/idempotency";

const LOCK_TTL_MS = 2 * 60 * 1000;
type ReaderEnvironment = { STRIPE_TERMINAL_READER_ID?: string; STRIPE_TERMINAL_LOCATION_ID?: string };
type LockedReaderRow = {
  id: string;
  stripe_reader_id: string;
  stripe_location_id: string;
  active: boolean;
  lock_payment_attempt_id: string | null;
  lock_expires_at: Date | null;
};

export async function reserveConfiguredReader(db: Database, env: ReaderEnvironment, paymentAttemptId: string, now = new Date()) {
  const readerId = env.STRIPE_TERMINAL_READER_ID;
  const locationId = env.STRIPE_TERMINAL_LOCATION_ID;
  if (!readerId || !locationId) return { status: "TERMINAL_OFFLINE" as const };
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql<{
      id: string; stripe_reader_id: string; stripe_location_id: string; active: boolean;
      lock_payment_attempt_id: string | null; lock_expires_at: Date | null;
    }>`select id, stripe_reader_id, stripe_location_id, active, lock_payment_attempt_id, lock_expires_at
       from terminal_readers where stripe_reader_id = ${readerId} for update`);
    const reader = rows[0] as unknown as LockedReaderRow | undefined;
    if (!reader || !reader.active || reader.stripe_location_id !== locationId) return { status: "TERMINAL_OFFLINE" as const };
    const decision = decideReaderReservation({
      requestedAttemptId: paymentAttemptId,
      lockedAttemptId: reader.lock_payment_attempt_id,
      lockExpiresAt: reader.lock_expires_at,
      now,
    });
    if (decision === "BUSY") return { status: "TERMINAL_BUSY" as const, retryAfter: reader.lock_expires_at };
    if (decision === "ACQUIRE") {
      await tx.update(terminalReaders).set({
        lockPaymentAttemptId: paymentAttemptId, lockAcquiredAt: now,
        lockExpiresAt: new Date(now.getTime() + LOCK_TTL_MS), updatedAt: now,
      }).where(eq(terminalReaders.id, reader.id));
    }
    return { status: decision === "RESUME" ? "RESUMED" as const : "RESERVED" as const, readerId: reader.id };
  });
}
