import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { emailDeliveries } from "@/db/schema";
import { receiptIdempotencyKey } from "./receipt-delivery";

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
});
