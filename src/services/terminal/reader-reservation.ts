import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { terminalReaders } from "@/db/schema";
import { decideReaderReservation } from "@/domain/payments/idempotency";

const LOCK_TTL_MS = 10 * 60 * 1000;
type ReaderEnvironment = { STRIPE_TERMINAL_READER_ID?: string; STRIPE_TERMINAL_LOCATION_ID?: string };

export async function syncConfiguredReader(db: Database, env: ReaderEnvironment) {
  const stripeReaderId = env.STRIPE_TERMINAL_READER_ID;
  const stripeLocationId = env.STRIPE_TERMINAL_LOCATION_ID;
  if (!stripeReaderId || !stripeLocationId) return null;
  const [reader] = await db.insert(terminalReaders).values({
    label: "Configured physical S710",
    stripeReaderId,
    stripeLocationId,
    active: true,
  }).onConflictDoUpdate({
    target: terminalReaders.stripeReaderId,
    set: { stripeLocationId, active: true, updatedAt: new Date() },
  }).returning({ id: terminalReaders.id });
  return reader;
}

export async function reserveConfiguredReader(db: Database, env: ReaderEnvironment, paymentAttemptId: string, now = new Date()) {
  const readerId = env.STRIPE_TERMINAL_READER_ID;
  const locationId = env.STRIPE_TERMINAL_LOCATION_ID;
  if (!readerId || !locationId) return { status: "TERMINAL_OFFLINE" as const };
  return db.transaction(async (tx) => {
    // Use mapped timestamps: raw driver results expose timestamptz as strings.
    const [reader] = await tx.select().from(terminalReaders)
      .where(eq(terminalReaders.stripeReaderId, readerId)).limit(1).for("update");
    if (!reader || !reader.active || reader.stripeLocationId !== locationId) return { status: "TERMINAL_OFFLINE" as const };
    const decision = decideReaderReservation({
      requestedAttemptId: paymentAttemptId,
      lockedAttemptId: reader.lockPaymentAttemptId,
      lockExpiresAt: reader.lockExpiresAt,
      now,
    });
    if (decision === "BUSY") return {
      status: "TERMINAL_BUSY" as const,
      retryAfter: reader.lockExpiresAt,
      lockedPaymentAttemptId: reader.lockPaymentAttemptId,
    };
    if (decision === "ACQUIRE") {
      await tx.update(terminalReaders).set({
        lockPaymentAttemptId: paymentAttemptId, lockAcquiredAt: now,
        lockExpiresAt: new Date(now.getTime() + LOCK_TTL_MS), updatedAt: now,
      }).where(eq(terminalReaders.id, reader.id));
    }
    return { status: decision === "RESUME" ? "RESUMED" as const : "RESERVED" as const, readerId: reader.id };
  });
}

export async function extendReaderReservation(db: Database, readerId: string, paymentAttemptId: string, now = new Date()) {
  await db.update(terminalReaders).set({
    lockExpiresAt: new Date(now.getTime() + LOCK_TTL_MS),
    updatedAt: now,
  }).where(and(eq(terminalReaders.id, readerId), eq(terminalReaders.lockPaymentAttemptId, paymentAttemptId)));
}

export async function releaseReaderReservation(db: Database, paymentAttemptId: string, now = new Date()) {
  await db.update(terminalReaders).set({
    lockPaymentAttemptId: null,
    lockAcquiredAt: null,
    lockExpiresAt: null,
    updatedAt: now,
  }).where(eq(terminalReaders.lockPaymentAttemptId, paymentAttemptId));
}
