import { calculateProcessingFee } from "@/domain/payments/processing-fee";
import { trustedGlCodeForCustomCharge, trustedGlCodeForProduct } from "@/domain/accounting/gl-rules";
import type { TrustedProduct } from "@/domain/products/catalog";
import { checkoutRequestSchema } from "./validation";

export class FinancialValidationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export type TrustedLine = {
  productId: string | null;
  productNameSnapshot: string;
  unitPriceCentsSnapshot: number;
  quantity: number;
  glCodeSnapshot: string;
  lineTotalCents: number;
  custom: boolean;
};

export function reconstructTrustedTransaction(
  untrustedInput: unknown,
  trustedProducts: readonly TrustedProduct[],
) {
  const request = checkoutRequestSchema.parse(untrustedInput);
  const productById = new Map(trustedProducts.map((product) => [product.id, product]));
  const quantities = new Map<string, number>();
  for (const item of request.items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);

  const lines: TrustedLine[] = [];
  for (const [productId, quantity] of quantities) {
    const product = productById.get(productId);
    if (!product || !product.active || !product.terminalEnabled) {
      throw new FinancialValidationError("PRODUCT_UNAVAILABLE", `Product ${productId} is unavailable.`);
    }
    if (!product.quantityAllowed && quantity !== 1) {
      throw new FinancialValidationError("QUANTITY_NOT_ALLOWED", `${product.displayName} can only be added once.`);
    }
    if (quantity > 99) throw new FinancialValidationError("QUANTITY_TOO_LARGE", "Quantity exceeds the allowed maximum.");
    lines.push({
      productId: product.id,
      productNameSnapshot: product.displayName,
      unitPriceCentsSnapshot: product.priceCents,
      quantity,
      glCodeSnapshot: trustedGlCodeForProduct(product.id),
      lineTotalCents: product.priceCents * quantity,
      custom: false,
    });
  }

  for (const custom of request.customCharges) {
    lines.push({
      productId: null,
      productNameSnapshot: custom.description,
      unitPriceCentsSnapshot: custom.amountCents,
      quantity: 1,
      glCodeSnapshot: trustedGlCodeForCustomCharge(),
      lineTotalCents: custom.amountCents,
      custom: true,
    });
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const processingFeeCents = calculateProcessingFee(subtotalCents);
  return {
    unitNumber: request.unitNumber,
    customerEmail: request.customerEmail.toLowerCase(),
    lines,
    subtotalCents,
    processingFeeCents,
    totalCents: subtotalCents + processingFeeCents,
  };
}
