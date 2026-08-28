import { describe, expect, it } from "vitest";
import { buildTrustedReaderCart } from "./reader-cart";

describe("trusted S710 cart", () => {
  it("builds products, custom charges, processing fee, and the exact PaymentIntent total", () => {
    const cart = buildTrustedReaderCart(
      { subtotalCents: 9_000, processingFeeCents: 291, totalCents: 9_291 },
      [
        { productId: "parking_fob", productNameSnapshot: "Parking Fob", unitPriceCentsSnapshot: 5_500, quantity: 1, lineTotalCents: 5_500 },
        { productId: "mailbox_key_copy", productNameSnapshot: "Mailbox Key Copy", unitPriceCentsSnapshot: 1_000, quantity: 2, lineTotalCents: 2_000 },
        { productId: null, productNameSnapshot: "Replacement part", unitPriceCentsSnapshot: 1_500, quantity: 1, lineTotalCents: 1_500 },
      ],
    );

    expect(cart).toEqual({
      currency: "usd",
      lineItems: [
        { description: "Parking Fob", amountCents: 5_500, quantity: 1 },
        { description: "Mailbox Key Copy", amountCents: 1_000, quantity: 2 },
        { description: "Custom Charge: Replacement part", amountCents: 1_500, quantity: 1 },
        { description: "Processing Fee", amountCents: 291, quantity: 1 },
      ],
      totalCents: 9_291,
    });
    const paymentIntentAmountCents = cart.totalCents;
    expect(paymentIntentAmountCents).toBe(9_291);
    expect(JSON.stringify(cart)).not.toMatch(/40090|40033|unitNumber|customerEmail/u);
  });

  it("rejects any mismatch between snapshots, fee policy, display total, and payment amount", () => {
    const item = { productId: "parking_fob", productNameSnapshot: "Parking Fob", unitPriceCentsSnapshot: 5_500, quantity: 1, lineTotalCents: 5_500 };
    expect(() => buildTrustedReaderCart({ subtotalCents: 5_400, processingFeeCents: 187, totalCents: 5_587 }, [item])).toThrow(/subtotal/u);
    expect(() => buildTrustedReaderCart({ subtotalCents: 5_500, processingFeeCents: 188, totalCents: 5_688 }, [item])).toThrow(/processing fee/u);
    expect(() => buildTrustedReaderCart({ subtotalCents: 5_500, processingFeeCents: 190, totalCents: 5_689 }, [item])).toThrow(/total/u);
  });

  it("shows trusted printing quantities and the same authoritative total on the S710", () => {
    const cart = buildTrustedReaderCart(
      { subtotalCents: 130, processingFeeCents: 34, totalCents: 164 },
      [
        { productId: "black_white_printing", productNameSnapshot: "Black & White Printing", unitPriceCentsSnapshot: 10, quantity: 3, lineTotalCents: 30 },
        { productId: "color_printing", productNameSnapshot: "Color Printing", unitPriceCentsSnapshot: 25, quantity: 4, lineTotalCents: 100 },
      ],
    );
    expect(cart.lineItems).toEqual([
      { description: "Black & White Printing", amountCents: 10, quantity: 3 },
      { description: "Color Printing", amountCents: 25, quantity: 4 },
      { description: "Processing Fee", amountCents: 34, quantity: 1 },
    ]);
    expect(cart.totalCents).toBe(164);
  });
});
