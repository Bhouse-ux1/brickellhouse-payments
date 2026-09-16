import { describe, expect, it } from "vitest";
import { productCatalog } from "../products/catalog";
import { calculateProcessingFee } from "../payments/processing-fee";
import { reconstructTrustedTransaction } from "./reconstruct";
import { checkoutRequestSchema, maximumQuantityForProduct, parseQuantityInput } from "./validation";

const request = (productId: string, quantity: unknown) => ({
  unitNumber: "LOCAL", customerEmail: "resident@example.invalid",
  items: [{ productId, quantity }],
  // Keep a one-page printing request above the unchanged payment minimum.
  customCharges: [{ description: "Local fixture", amountCents: 19 }],
});

describe.each(["black_white_printing", "color_printing"])("trusted printing quantities: %s", productId => {
  it.each([1, 99, 100, 999, 1000])("accepts %i and reconstructs prices, fees and snapshots from trusted data", quantity => {
    const maximum = maximumQuantityForProduct(productId);
    expect(maximum).toBe(1000);
    expect(parseQuantityInput(String(quantity), maximum)).toBe(quantity);
    expect(checkoutRequestSchema.safeParse(request(productId, quantity)).success).toBe(true);
    const input = request(productId, quantity);
    const result = reconstructTrustedTransaction({ ...input, items: [{ ...input.items[0], priceCents: 1, lineTotalCents: 1, maximumQuantity: 9999 }], totalCents: 1 }, productCatalog);
    const product = productCatalog.find(p => p.id === productId)!;
    expect(result.lines[0]).toMatchObject({ productId, quantity, unitPriceCentsSnapshot: product.priceCents, lineTotalCents: product.priceCents * quantity, glCodeSnapshot: "40090" });
    expect(result.subtotalCents).toBe(product.priceCents * quantity + 19);
    expect(result.processingFeeCents).toBe(calculateProcessingFee(result.subtotalCents));
    expect(result.totalCents).toBe(result.subtotalCents + result.processingFeeCents);
  });

  it.each([1001, 0, -1, 1.5, "100", Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid quantity %s on the server", quantity => {
    expect(checkoutRequestSchema.safeParse(request(productId, quantity)).success).toBe(false);
    expect(() => reconstructTrustedTransaction(request(productId, quantity), productCatalog)).toThrow();
  });

  it("enforces the maximum after combining duplicate product lines", () => {
    const input = request(productId, 500);
    expect(reconstructTrustedTransaction({ ...input, items: [input.items[0], input.items[0]] }, productCatalog).lines[0].quantity).toBe(1000);
    expect(() => reconstructTrustedTransaction({ ...input, items: [{ productId, quantity: 1000 }, { productId, quantity: 1 }] }, productCatalog)).toThrow("Quantity exceeds the allowed maximum.");
  });

  it("retains the trusted single-quantity restriction when configured", () => {
    const restricted = productCatalog.map(p => p.id === productId ? { ...p, quantityAllowed: false } : p);
    expect(() => reconstructTrustedTransaction(request(productId, 2), restricted)).toThrow("can only be added once");
  });
});

describe("other product quantity limits", () => {
  it.each(productCatalog.filter(p => p.category !== "Printing"))("retains 99 for $displayName and rejects a forged printing limit", product => {
    expect(maximumQuantityForProduct(product.id)).toBe(99);
    expect(reconstructTrustedTransaction(request(product.id, 99), productCatalog).lines[0].quantity).toBe(99);
    const input = request(product.id, 100);
    expect(() => reconstructTrustedTransaction({ ...input, items: [{ ...input.items[0], category: "Printing", maximumQuantity: 1000 }] }, productCatalog)).toThrow();
    expect(() => reconstructTrustedTransaction({ ...input, items: [{ productId: product.id, quantity: 50 }, { productId: product.id, quantity: 50 }] }, productCatalog)).toThrow("Quantity exceeds the allowed maximum.");
  });

  it("does not extend the printing exception to new or similarly named products", () => {
    expect(maximumQuantityForProduct("other_printing")).toBe(99);
    expect(maximumQuantityForProduct("COLOR_PRINTING")).toBe(99);
  });
});
