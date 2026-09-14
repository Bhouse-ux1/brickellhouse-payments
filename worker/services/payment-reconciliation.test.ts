import { describe, expect, it } from "vitest";
import { buildPaidDeliveryRows } from "./payment-reconciliation";

describe("paid transaction notification planning", () => {
  it("creates independent customer and management deliveries", () => {
    expect(buildPaidDeliveryRows({
      transactionId: "transaction-1",
      customerEmail: "resident@example.com",
      managementNotificationEmail: "management@example.com",
    })).toEqual([
      {
        transactionId: "transaction-1",
        kind: "RESIDENT_RECEIPT",
        recipientEmail: "resident@example.com",
        status: "PENDING",
      },
      {
        transactionId: "transaction-1",
        kind: "MANAGEMENT_PAYMENT_CONFIRMATION",
        recipientEmail: "management@example.com",
        status: "PENDING",
      },
    ]);
  });

  it("never blocks the customer receipt when management configuration is absent or invalid", () => {
    for (const managementNotificationEmail of [undefined, "invalid"]) {
      expect(buildPaidDeliveryRows({
        transactionId: "transaction-1",
        customerEmail: "resident@example.com",
        managementNotificationEmail,
      })).toHaveLength(1);
    }
  });
});
