export const PROCESSING_FEE_POLICY = Object.freeze({
  percentageNumerator: 29,
  percentageDenominator: 1000,
  fixedFeeCents: 30,
});

export function calculateProcessingFee(subtotalCents: number): number {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) {
    throw new Error("Subtotal must be a nonnegative integer number of cents.");
  }
  if (subtotalCents === 0) return 0;
  return Math.round(subtotalCents * PROCESSING_FEE_POLICY.percentageNumerator / PROCESSING_FEE_POLICY.percentageDenominator)
    + PROCESSING_FEE_POLICY.fixedFeeCents;
}
