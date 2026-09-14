import { describe, expect, it } from "vitest";
import { meetsMinimumPayment, MINIMUM_PAYMENT_CENTS, MINIMUM_PAYMENT_MESSAGE } from "./minimum-payment";

describe("payment minimum", () => {
  it("rejects below $0.50 and accepts exact and above totals", () => {
    expect(MINIMUM_PAYMENT_CENTS).toBe(50);
    expect(MINIMUM_PAYMENT_MESSAGE).toBe("Minimum payment is $0.50.");
    expect(meetsMinimumPayment(49)).toBe(false);
    expect(meetsMinimumPayment(50)).toBe(true);
    expect(meetsMinimumPayment(51)).toBe(true);
  });
});
