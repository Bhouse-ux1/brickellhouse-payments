import { z } from "zod";

export const MAX_QUANTITY = 99;
export const MAX_CUSTOM_CHARGE_CENTS = 10_000_000;

export const checkoutRequestSchema = z.object({
  unitNumber: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9 -]+$/, "Enter a valid unit number"),
  customerEmail: z.email().max(320),
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(64),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
  })).max(100).default([]),
  customCharges: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    amountCents: z.number().int().min(1).max(MAX_CUSTOM_CHARGE_CENTS),
  })).max(10).default([]),
}).refine((value) => value.items.length > 0 || value.customCharges.length > 0, {
  message: "Add at least one product or custom charge",
});

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export function parseQuantityInput(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) return null;
  const quantity = Number(normalized);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY ? quantity : null;
}

export function parseMoneyInput(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CUSTOM_CHARGE_CENTS ? cents : null;
}
