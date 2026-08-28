import { describe, expect, it } from "vitest";
import { renderReceiptEmail, validateTrustedReceipt } from "./receipt-email";

const trustedReceipt = {
  transactionNumber: "POS-000123",
  paidAt: new Date("2026-08-28T18:35:00.000Z"),
  items: [
    { name: "Parking Fob", quantity: 1, unitAmountCents: 5_500, lineTotalCents: 5_500 },
    { name: "Custom <Repair> & Service", quantity: 2, unitAmountCents: 1_000, lineTotalCents: 2_000 },
  ],
  subtotalCents: 7_500,
  processingFeeCents: 248,
  totalCents: 7_748,
  cardBrand: "visa",
  cardLastFour: "1234",
};

describe("verified payment receipt", () => {
  it("renders trusted item snapshots, exact totals, fee, and safe card details", () => {
    const receipt = renderReceiptEmail(trustedReceipt);
    expect(receipt.html).toContain("Thank for stopping by!");
    expect(receipt.html).toContain("POS-000123");
    expect(receipt.html).toContain("$77.48");
    expect(receipt.html).toContain("Processing Fee");
    expect(receipt.html).toContain("Visa &bull;&bull;&bull;&bull; 1234");
    expect(receipt.html).not.toMatch(/PaymentIntent|reader|GL|database|webhook/iu);
  });

  it("escapes custom charge descriptions", () => {
    const receipt = renderReceiptEmail(trustedReceipt);
    expect(receipt.html).toContain("Custom &lt;Repair&gt; &amp; Service");
    expect(receipt.html).not.toContain("Custom <Repair>");
  });

  it("omits optional card details when unavailable", () => {
    const receipt = renderReceiptEmail({ ...trustedReceipt, cardBrand: null, cardLastFour: null });
    expect(receipt.html).not.toContain("&bull;&bull;&bull;&bull;");
  });

  it("rejects any receipt whose items or total differ from trusted snapshots", () => {
    expect(() => validateTrustedReceipt({ ...trustedReceipt, totalCents: 7_749 })).toThrow(/total/u);
    expect(() => validateTrustedReceipt({ ...trustedReceipt, items: [{ ...trustedReceipt.items[0], lineTotalCents: 5_499 }] })).toThrow(/snapshot/u);
  });
});
