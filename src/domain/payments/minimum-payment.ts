export const MINIMUM_PAYMENT_CENTS = 50;
export const MINIMUM_PAYMENT_MESSAGE = "Minimum payment is $0.50.";

export function meetsMinimumPayment(totalCents: number): boolean {
  return Number.isSafeInteger(totalCents) && totalCents >= MINIMUM_PAYMENT_CENTS;
}
