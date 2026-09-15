import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { emailDeliveries, emailKindEnum, stripeEvents, transactionItems, transactions } from "@/db/schema";
import {
  deliverPaidTransactionEmail, managementPaymentIdempotencyKey, queueManagementNotificationRetry, receiptIdempotencyKey,
} from "./receipt-delivery";

describe("receipt duplicate protection", () => {
  it("permits only one base receipt-delivery row per transaction", () => {
    const indexes = getTableConfig(emailDeliveries).indexes;
    const receiptIndex = indexes.find((index) => index.config.name === "email_deliveries_receipt_once_uidx");
    expect(receiptIndex?.config.unique).toBe(true);
  });

  it("reuses the provider key for retries and changes it only for an intentional resend", () => {
    expect(receiptIdempotencyKey("transaction-1", 1)).toBe(receiptIdempotencyKey("transaction-1", 1));
    expect(receiptIdempotencyKey("transaction-1", 2)).not.toBe(receiptIdempotencyKey("transaction-1", 1));
    expect(() => receiptIdempotencyKey("transaction-1", 0)).toThrow("identity");
  });

  it("converges distinct success Event IDs onto one PaymentIntent, Charge, and receipt identity", () => {
    expect(stripeEvents.stripeEventId.isUnique).toBe(true);
    expect(transactions.stripePaymentIntentId.isUnique).toBe(true);
    expect(transactions.stripeChargeId.isUnique).toBe(true);
    const receiptIndex = getTableConfig(emailDeliveries).indexes
      .find((index) => index.config.name === "email_deliveries_receipt_once_uidx");
    expect(receiptIndex?.config.unique).toBe(true);
  });

  it("gives customer and management deliveries separate stable identities", () => {
    expect(emailKindEnum.enumValues).toEqual(["RESIDENT_RECEIPT", "MANAGEMENT_PAYMENT_CONFIRMATION"]);
    expect(receiptIdempotencyKey("transaction-1", 1)).not.toBe(managementPaymentIdempotencyKey("transaction-1", 1));
    expect(managementPaymentIdempotencyKey("transaction-1", 1)).toBe("payment-confirmation/transaction-1/v1");
  });

  it("requeues only a failed management notification without changing its idempotency version", async () => {
    const results = [[{ status: "PAID" }], [{
      id: "delivery-1", status: "FAILED", deliveryVersion: 1, providerMessageId: null,
    }]];
    const updateWhere = vi.fn(async () => []);
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ limit: vi.fn(async () => results.shift() ?? []) }) }),
      })),
      update: vi.fn(() => ({ set: (values: Record<string, unknown>) => {
        expect(values).not.toHaveProperty("deliveryVersion");
        return { where: updateWhere };
      } })),
    };
    await expect(queueManagementNotificationRetry({ db: db as never, transactionId: "transaction-1" }))
      .resolves.toEqual({ status: "QUEUED" });
    expect(updateWhere).toHaveBeenCalledOnce();
  });

  it("does not resend an already-sent management notification", async () => {
    const results = [[{ status: "PAID" }], [{ id: "delivery-1", status: "SENT" }]];
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ limit: vi.fn(async () => results.shift() ?? []) }) }),
      })),
      update: vi.fn(),
    };
    await expect(queueManagementNotificationRetry({ db: db as never, transactionId: "transaction-1" }))
      .resolves.toEqual({ status: "ALREADY_SENT" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("allows only one provider send when concurrent success paths deliver the same receipt", async () => {
    const paidTransaction = {
      id: "transaction-1", number: "POS-000001", paymentStatus: "PAID", paidAt: new Date(),
      customerEmail: "resident@example.com", subtotalCents: 1_000, processingFeeCents: 59, totalCents: 1_059,
      cardBrand: "visa", cardLastFour: "4242",
    };
    const pendingDelivery = {
      id: "delivery-1", transactionId: "transaction-1", kind: "RESIDENT_RECEIPT",
      recipientEmail: "resident@example.com", status: "PENDING", deliveryVersion: 1,
    };
    let claimed = false;
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => {
          if (table === transactionItems) {
            return { where: () => ({ orderBy: vi.fn(async () => [{
              name: "Parking Fob", quantity: 1, unitAmountCents: 1_000, lineTotalCents: 1_000,
            }]) }) };
          }
          const row = table === transactions ? paidTransaction : pendingDelivery;
          return { where: () => ({ limit: vi.fn(async () => [row]) }) };
        },
      })),
      update: vi.fn(() => ({ set: (values: { status?: string }) => ({
        where: () => values.status === "SENDING"
          ? { returning: vi.fn(async () => {
            if (claimed) return [];
            claimed = true;
            return [{ id: "delivery-1" }];
          }) }
          : Promise.resolve([]),
      }) })),
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const input = {
      db: db as never,
      env: { RESEND_API_KEY: "re_placeholder", EMAIL_FROM: "orders@brickellhouse.org" } as never,
      transactionId: "transaction-1",
      kind: "RESIDENT_RECEIPT" as const,
      fetcher: fetcher as never,
    };
    const results = await Promise.all([
      deliverPaidTransactionEmail(input), deliverPaidTransactionEmail(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["IN_PROGRESS", "SENT"]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
