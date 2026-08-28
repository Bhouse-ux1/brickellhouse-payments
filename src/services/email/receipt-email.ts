export type ReceiptItem = {
  name: string;
  quantity: number;
  unitAmountCents: number;
  lineTotalCents: number;
};

export type TrustedReceipt = {
  transactionNumber: string;
  paidAt: Date;
  items: ReceiptItem[];
  subtotalCents: number;
  processingFeeCents: number;
  totalCents: number;
  cardBrand?: string | null;
  cardLastFour?: string | null;
};

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function escapeReceiptHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function validateTrustedReceipt(receipt: TrustedReceipt) {
  const itemSubtotal = receipt.items.reduce((sum, item) => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.lineTotalCents !== item.unitAmountCents * item.quantity) {
      throw new Error("Receipt item snapshot is inconsistent.");
    }
    return sum + item.lineTotalCents;
  }, 0);
  if (itemSubtotal !== receipt.subtotalCents || receipt.subtotalCents + receipt.processingFeeCents !== receipt.totalCents) {
    throw new Error("Receipt total is inconsistent with the trusted transaction.");
  }
  if (receipt.cardLastFour && !/^\d{4}$/u.test(receipt.cardLastFour)) throw new Error("Receipt card details are invalid.");
}

function safeCard(receipt: TrustedReceipt) {
  if (!receipt.cardBrand || !receipt.cardLastFour) return "";
  const brand = receipt.cardBrand.charAt(0).toUpperCase() + receipt.cardBrand.slice(1).toLowerCase();
  return `<div style="margin-top:24px;color:#6b706b;font-size:13px">${escapeReceiptHtml(brand)} &bull;&bull;&bull;&bull; ${escapeReceiptHtml(receipt.cardLastFour)}</div>`;
}

export function renderReceiptEmail(receipt: TrustedReceipt) {
  validateTrustedReceipt(receipt);
  const paidAt = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long", timeStyle: "short", timeZone: "America/New_York",
  }).format(receipt.paidAt);
  const rows = receipt.items.map((item) => {
    const detail = `${item.quantity} × ${currency.format(item.unitAmountCents / 100)}`;
    return `<tr><td style="padding:14px 12px 14px 0;border-bottom:1px solid #e7e1d7"><div style="font-size:14px;color:#252824">${escapeReceiptHtml(item.name)}</div><div style="margin-top:4px;font-size:12px;color:#81857f">${detail}</div></td><td style="padding:14px 0 14px 12px;border-bottom:1px solid #e7e1d7;text-align:right;white-space:nowrap;font-size:14px">${currency.format(item.lineTotalCents / 100)}</td></tr>`;
  }).join("");
  const fee = receipt.processingFeeCents > 0
    ? `<tr><td style="padding:14px 12px 14px 0;border-bottom:1px solid #e7e1d7;color:#555b55;font-size:14px">Processing Fee</td><td style="padding:14px 0 14px 12px;border-bottom:1px solid #e7e1d7;text-align:right;white-space:nowrap;font-size:14px">${currency.format(receipt.processingFeeCents / 100)}</td></tr>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#eee9df;color:#252824;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><div style="max-width:620px;margin:0 auto;padding:48px 18px"><h1 style="margin:0;font-size:30px;line-height:1.15;font-weight:500;letter-spacing:-.02em">Thank for stopping by!</h1><div style="margin-top:8px;color:#174c3c;font-size:14px;letter-spacing:.04em">BrickellHouse Management</div><div style="margin-top:32px;padding:30px;background:#fffdf8;border:1px solid #d9d2c5"><div style="font-size:17px;font-weight:600">${escapeReceiptHtml(receipt.transactionNumber)}</div><div style="margin-top:5px;color:#7b807a;font-size:12px">${escapeReceiptHtml(paidAt)}</div><table role="presentation" style="width:100%;margin-top:24px;border-collapse:collapse">${rows}${fee}<tr><td style="padding-top:20px;font-size:17px;font-weight:600">Total</td><td style="padding:20px 0 0 12px;text-align:right;white-space:nowrap;font-size:20px;font-weight:600;color:#174c3c">${currency.format(receipt.totalCents / 100)}</td></tr></table>${safeCard(receipt)}</div><div style="margin-top:28px;color:#696e68;font-size:12px;line-height:1.7">BrickellHouse Management<br>305 400 9661 ext. 7002</div></div></body></html>`;
  const itemText = receipt.items.map((item) => `${item.name}  ${item.quantity} × ${currency.format(item.unitAmountCents / 100)}  ${currency.format(item.lineTotalCents / 100)}`).join("\n");
  const text = `Thank for stopping by!\nBrickellHouse Management\n\n${receipt.transactionNumber}\n${paidAt}\n\n${itemText}${receipt.processingFeeCents > 0 ? `\nProcessing Fee  ${currency.format(receipt.processingFeeCents / 100)}` : ""}\n\nTotal  ${currency.format(receipt.totalCents / 100)}${receipt.cardBrand && receipt.cardLastFour ? `\n${receipt.cardBrand} •••• ${receipt.cardLastFour}` : ""}\n\nBrickellHouse Management\n305 400 9661 ext. 7002\n`;
  return { subject: `BrickellHouse receipt ${receipt.transactionNumber}`, html, text };
}
