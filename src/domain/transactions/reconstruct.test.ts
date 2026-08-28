import { describe, expect, it } from "vitest";
import { calculateProcessingFee } from "@/domain/payments/processing-fee";
import { productCatalog } from "@/domain/products/catalog";
import { reconstructTrustedTransaction } from "./reconstruct";
import { parseMoneyInput, parseQuantityInput } from "./validation";

describe("trusted transaction reconstruction", () => {
  it("ignores malicious browser prices, GL codes, fees, and totals", () => {
    const result = reconstructTrustedTransaction({
      unitNumber: "2305",
      customerEmail: "Resident@Example.com",
      items: [{ productId: "parking_fob", quantity: 1, priceCents: 1, glCode: "99999", lineTotalCents: 1 }],
      processingFeeCents: 1,
      totalCents: 1,
    }, productCatalog);
    expect(result.lines[0]).toMatchObject({
      productNameSnapshot: "Parking Fob",
      unitPriceCentsSnapshot: 5500,
      glCodeSnapshot: "40090",
      lineTotalCents: 5500,
    });
    expect(result.processingFeeCents).toBe(190);
    expect(result.totalCents).toBe(5690);
  });

  it("validates custom money strings without floating point authority", () => {
    expect(parseMoneyInput("$100.00")).toBe(10000);
    expect(parseMoneyInput("12.3")).toBe(1230);
    expect(parseMoneyInput("0")).toBeNull();
    expect(parseMoneyInput("-1.00")).toBeNull();
    expect(parseMoneyInput("1.234")).toBeNull();
  });

  it("assigns Custom Charge to fixed GL 40090 and ignores browser totals", () => {
    const result = reconstructTrustedTransaction({
      unitNumber: "2305", customerEmail: "resident@example.com", items: [],
      customCharges: [{ description: "Replacement item", amountCents: 10000, glCode: "12345" }],
      processingFeeCents: 0, totalCents: 1,
    }, productCatalog);
    expect(result.lines[0].glCodeSnapshot).toBe("40090");
    expect(result.totalCents).toBe(10320);
  });

  it("reconstructs a Custom Charge and calculates its fee", () => {
    const result = reconstructTrustedTransaction({
      unitNumber: "2305", customerEmail: "resident@example.com", items: [],
      customCharges: [{ description: "Replacement item", amountCents: 10000 }],
    }, productCatalog);
    expect(result.subtotalCents).toBe(10000);
    expect(result.processingFeeCents).toBe(320);
    expect(result.totalCents).toBe(10320);
  });

  it("enforces 40090 for every product except Valet Parking, which uses 40033", () => {
    for (const product of productCatalog) {
      const forged = productCatalog.map((item) => ({ ...item, glCode: "12345" }));
      const result = reconstructTrustedTransaction({
        unitNumber: "2305", customerEmail: "resident@example.com",
        items: [{ productId: product.id, quantity: 1 }], customCharges: [],
      }, forged);
      expect(result.lines[0].glCodeSnapshot).toBe(product.id === "valet_parking" ? "40033" : "40090");
    }
  });

  it("keeps printing prices trusted and carries typed quantities through every total", () => {
    const blackAndWhite = productCatalog.find((product) => product.id === "black_white_printing");
    const color = productCatalog.find((product) => product.id === "color_printing");
    expect(blackAndWhite).toMatchObject({ displayName: "Black & White Printing", priceCents: 10, glCode: "40090", quantityAllowed: true });
    expect(color).toMatchObject({ displayName: "Color Printing", priceCents: 25, glCode: "40090", quantityAllowed: true });
    expect(productCatalog.every((product) => product.quantityAllowed)).toBe(true);

    const result = reconstructTrustedTransaction({
      unitNumber: "2305", customerEmail: "resident@example.com",
      items: [
        { productId: "black_white_printing", quantity: 3, priceCents: 9999 },
        { productId: "color_printing", quantity: 4, priceCents: 9999 },
      ],
    }, productCatalog);
    expect(result.lines).toMatchObject([
      { productNameSnapshot: "Black & White Printing", unitPriceCentsSnapshot: 10, quantity: 3, lineTotalCents: 30, glCodeSnapshot: "40090" },
      { productNameSnapshot: "Color Printing", unitPriceCentsSnapshot: 25, quantity: 4, lineTotalCents: 100, glCodeSnapshot: "40090" },
    ]);
    expect(result.subtotalCents).toBe(130);
    expect(result.processingFeeCents).toBe(34);
    expect(result.totalCents).toBe(164);
  });

  it("accepts only typed whole-number quantities within the server limit", () => {
    expect(parseQuantityInput("12")).toBe(12);
    expect(parseQuantityInput(" 99 ")).toBe(99);
    expect(parseQuantityInput("0")).toBeNull();
    expect(parseQuantityInput("100")).toBeNull();
    expect(parseQuantityInput("2.5")).toBeNull();
    expect(parseQuantityInput("1e2")).toBeNull();
  });
});

describe("processing fee", () => {
  it("uses round(subtotal × 29 / 1000) + 30", () => {
    expect(calculateProcessingFee(0)).toBe(0);
    expect(calculateProcessingFee(10000)).toBe(320);
    expect(calculateProcessingFee(5500)).toBe(190);
  });
  it("rejects invalid cents", () => {
    expect(() => calculateProcessingFee(-1)).toThrow();
    expect(() => calculateProcessingFee(1.5)).toThrow();
  });
});
