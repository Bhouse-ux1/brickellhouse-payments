import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { emailDeliveries, emailKindEnum } from "@/db/schema";
import { managementPaymentIdempotencyKey, receiptIdempotencyKey } from "./receipt-delivery";

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

  it("gives customer and management deliveries separate stable identities", () => {
    expect(emailKindEnum.enumValues).toEqual(["RESIDENT_RECEIPT", "MANAGEMENT_PAYMENT_CONFIRMATION"]);
    expect(receiptIdempotencyKey("transaction-1", 1)).not.toBe(managementPaymentIdempotencyKey("transaction-1", 1));
    expect(managementPaymentIdempotencyKey("transaction-1", 1)).toBe("payment-confirmation/transaction-1/v1");
  });
});
