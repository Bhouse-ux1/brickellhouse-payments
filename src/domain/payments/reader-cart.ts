import { calculateProcessingFee } from "@/domain/payments/processing-fee";

export type TrustedReaderCartLine = {
  description: string;
  amountCents: number;
  quantity: number;
};

export type TrustedReaderCart = {
  currency: "usd";
  lineItems: TrustedReaderCartLine[];
  totalCents: number;
};

type TransactionAmounts = {
  subtotalCents: number;
  processingFeeCents: number;
  totalCents: number;
};

type TransactionItemSnapshot = {
  productId: string | null;
  productNameSnapshot: string;
  unitPriceCentsSnapshot: number;
  quantity: number;
  lineTotalCents: number;
};

function requireMoney(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer number of cents.`);
}

export function buildTrustedReaderCart(
  transaction: TransactionAmounts,
  items: readonly TransactionItemSnapshot[],
): TrustedReaderCart {
  if (items.length === 0) throw new Error("The transaction has no trusted item snapshots.");

  const lineItems = items.map((item) => {
    requireMoney(item.unitPriceCentsSnapshot, "Item unit price");
    requireMoney(item.lineTotalCents, "Item line total");
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new Error("Item quantity must be a positive integer.");
    if (item.unitPriceCentsSnapshot * item.quantity !== item.lineTotalCents) {
      throw new Error("Item snapshot amount is inconsistent.");
    }
    const snapshotName = item.productNameSnapshot.trim();
    if (!snapshotName) throw new Error("Item snapshot description is missing.");
    return {
      description: item.productId === null ? `Custom Charge: ${snapshotName}` : snapshotName,
      amountCents: item.unitPriceCentsSnapshot,
      quantity: item.quantity,
    };
  });

  const subtotalCents = lineItems.reduce((sum, item) => sum + item.amountCents * item.quantity, 0);
  requireMoney(transaction.subtotalCents, "Transaction subtotal");
  requireMoney(transaction.processingFeeCents, "Processing fee");
  requireMoney(transaction.totalCents, "Transaction total");
  if (subtotalCents !== transaction.subtotalCents) throw new Error("Trusted item snapshots do not match the transaction subtotal.");

  const processingFeeCents = calculateProcessingFee(subtotalCents);
  if (processingFeeCents !== transaction.processingFeeCents) throw new Error("Stored processing fee is inconsistent.");
  if (subtotalCents + processingFeeCents !== transaction.totalCents) throw new Error("Stored transaction total is inconsistent.");

  lineItems.push({ description: "Processing Fee", amountCents: processingFeeCents, quantity: 1 });
  const displayedTotalCents = lineItems.reduce((sum, item) => sum + item.amountCents * item.quantity, 0);
  if (displayedTotalCents !== transaction.totalCents) throw new Error("Reader cart total does not match the payment amount.");

  return { currency: "usd", lineItems, totalCents: displayedTotalCents };
}
