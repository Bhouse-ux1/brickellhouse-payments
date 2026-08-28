import { and, eq, ne } from "drizzle-orm";
import type { Database } from "@/db/client";
import { emailDeliveries, paymentAttempts, terminalReaders, transactions } from "@/db/schema";
import type { StripePaymentIntent } from "@worker/services/stripe-client";

function safeCardDetails(intent: StripePaymentIntent) {
  const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const card = charge?.payment_method_details?.card_present;
  const lastFour = card?.last4?.match(/^\d{4}$/u)?.[0] ?? null;
  const brand = card?.brand?.slice(0, 40) ?? null;
  return { chargeId: charge?.id ?? null, brand, lastFour };
}

export async function markPaymentSucceeded(input: {
  db: Database;
  transactionId: string;
  paymentAttemptId: string;
  paymentIntent: StripePaymentIntent;
  readerId: string;
  locationId: string;
  customerEmail: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const card = safeCardDetails(input.paymentIntent);
  await input.db.transaction(async (tx) => {
    await tx.update(paymentAttempts).set({ status: "SUCCEEDED", completedAt: now, updatedAt: now, lastErrorCode: null, lastErrorMessage: null })
      .where(eq(paymentAttempts.id, input.paymentAttemptId));
    await tx.update(transactions).set({
      paymentStatus: "PAID", paymentMethod: "STRIPE_TERMINAL", paidAt: now,
      stripePaymentIntentId: input.paymentIntent.id, stripeChargeId: card.chargeId,
      stripeReaderId: input.readerId, stripeLocationId: input.locationId,
      cardBrand: card.brand, cardLastFour: card.lastFour, updatedAt: now,
    }).where(and(eq(transactions.id, input.transactionId), ne(transactions.paymentStatus, "PAID")));
    await tx.insert(emailDeliveries).values({
      transactionId: input.transactionId,
      recipientEmail: input.customerEmail,
      status: "PENDING",
      lastError: "Receipt delivery is not configured.",
    }).onConflictDoNothing();
    await tx.update(terminalReaders).set({
      lockPaymentAttemptId: null, lockAcquiredAt: null, lockExpiresAt: null, updatedAt: now,
    }).where(eq(terminalReaders.lockPaymentAttemptId, input.paymentAttemptId));
  });
}

export async function markPaymentFailed(input: {
  db: Database;
  transactionId: string;
  paymentAttemptId: string;
  code: string;
  message: string;
  canceled?: boolean;
  releaseReader?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const attemptStatus = input.canceled ? "CANCELED" as const : "FAILED" as const;
  const transactionStatus = input.canceled ? "CANCELED" as const : "FAILED" as const;
  await input.db.transaction(async (tx) => {
    await tx.update(paymentAttempts).set({
      status: attemptStatus, completedAt: now, lastErrorCode: input.code.slice(0, 100),
      lastErrorMessage: input.message, updatedAt: now,
    }).where(eq(paymentAttempts.id, input.paymentAttemptId));
    await tx.update(transactions).set({ paymentStatus: transactionStatus, updatedAt: now })
      .where(and(eq(transactions.id, input.transactionId), ne(transactions.paymentStatus, "PAID")));
    if (input.releaseReader !== false) {
      await tx.update(terminalReaders).set({
        lockPaymentAttemptId: null, lockAcquiredAt: null, lockExpiresAt: null, updatedAt: now,
      }).where(eq(terminalReaders.lockPaymentAttemptId, input.paymentAttemptId));
    }
  });
}
