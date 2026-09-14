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

export type TrustedManagementPayment = TrustedReceipt & { customerEmail: string };

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

function receiptRows(receipt: TrustedReceipt) {
  const rows = receipt.items.map((item) => {
    const detail = `${item.quantity} × ${currency.format(item.unitAmountCents / 100)}`;
    return `<tr><td style="padding:16px 12px 16px 0;border-bottom:1px solid #ded9cf"><div style="font-size:14px;color:#252824">${escapeReceiptHtml(item.name)}</div><div style="margin-top:4px;font-size:12px;color:#7b807a">${detail}</div></td><td style="padding:16px 0 16px 12px;border-bottom:1px solid #ded9cf;text-align:right;white-space:nowrap;font-size:14px">${currency.format(item.lineTotalCents / 100)}</td></tr>`;
  }).join("");
  const fee = receipt.processingFeeCents > 0
    ? `<tr><td style="padding:16px 12px 16px 0;border-bottom:1px solid #ded9cf;color:#555b55;font-size:14px">Processing Fee</td><td style="padding:16px 0 16px 12px;border-bottom:1px solid #ded9cf;text-align:right;white-space:nowrap;font-size:14px">${currency.format(receipt.processingFeeCents / 100)}</td></tr>`
    : "";
  return `${rows}${fee}<tr><td style="padding-top:22px;font-size:17px;font-weight:600">Total</td><td style="padding:22px 0 0 12px;text-align:right;white-space:nowrap;font-size:20px;font-weight:600;color:#174c3c">${currency.format(receipt.totalCents / 100)}</td></tr>`;
}

function receiptTextRows(receipt: TrustedReceipt) {
  return receipt.items.map((item) => `${item.name}  ${item.quantity} × ${currency.format(item.unitAmountCents / 100)}  ${currency.format(item.lineTotalCents / 100)}`).join("\n");
}

export function renderReceiptEmail(receipt: TrustedReceipt) {
  validateTrustedReceipt(receipt);
  const paidAt = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long", timeStyle: "short", timeZone: "America/New_York",
  }).format(receipt.paidAt);
  const html = `<!doctype html><html><body style="margin:0;background:#f3efe6;color:#252824;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><div style="max-width:590px;margin:0 auto;padding:54px 24px 48px"><h1 style="margin:0;font-size:30px;line-height:1.18;font-weight:500;letter-spacing:-.02em">Thank you for stopping by!</h1><div style="margin-top:9px;color:#174c3c;font-size:14px;letter-spacing:.04em">BrickellHouse Management</div><div style="margin-top:38px;color:#72776f;font-size:12px">${escapeReceiptHtml(paidAt)}</div><table role="presentation" style="width:100%;margin-top:14px;border-collapse:collapse">${receiptRows(receipt)}</table>${safeCard(receipt)}<div style="margin-top:42px;padding-top:20px;border-top:1px solid #d8d2c7;color:#696e68;font-size:12px;line-height:1.7">BrickellHouse Management<br>305 400 9661 ext. 7002</div></div></body></html>`;
  const text = `Thank you for stopping by!\nBrickellHouse Management\n\n${paidAt}\n\n${receiptTextRows(receipt)}${receipt.processingFeeCents > 0 ? `\nProcessing Fee  ${currency.format(receipt.processingFeeCents / 100)}` : ""}\n\nTotal  ${currency.format(receipt.totalCents / 100)}${receipt.cardBrand && receipt.cardLastFour ? `\n${receipt.cardBrand} •••• ${receipt.cardLastFour}` : ""}\n\nBrickellHouse Management\n305 400 9661 ext. 7002\n`;
  return { subject: "Your BrickellHouse payment receipt", html, text };
}

export function renderManagementPaymentEmail(payment: TrustedManagementPayment) {
  validateTrustedReceipt(payment);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(payment.customerEmail)) throw new Error("Management confirmation customer email is invalid.");
  const paidAt = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long", timeStyle: "short", timeZone: "America/New_York",
  }).format(payment.paidAt);
  const html = `<!doctype html><html><body style="margin:0;background:#f3efe6;color:#252824;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><div style="max-width:590px;margin:0 auto;padding:50px 24px"><div style="color:#174c3c;font-size:13px;letter-spacing:.08em;text-transform:uppercase">BrickellHouse Management</div><h1 style="margin:12px 0 0;font-size:27px;font-weight:500">Payment confirmation</h1><div style="margin-top:28px;padding:18px 0;border-top:1px solid #d8d2c7;border-bottom:1px solid #d8d2c7;font-size:13px;line-height:1.8"><strong>Internal transaction</strong> ${escapeReceiptHtml(payment.transactionNumber)}<br><strong>Paid</strong> ${escapeReceiptHtml(paidAt)}<br><strong>Customer email</strong> ${escapeReceiptHtml(payment.customerEmail)}</div><table role="presentation" style="width:100%;margin-top:16px;border-collapse:collapse">${receiptRows(payment)}</table>${safeCard(payment)}</div></body></html>`;
  const text = `BrickellHouse Management\nPayment confirmation\n\nInternal transaction  ${payment.transactionNumber}\nPaid  ${paidAt}\nCustomer email  ${payment.customerEmail}\n\n${receiptTextRows(payment)}${payment.processingFeeCents > 0 ? `\nProcessing Fee  ${currency.format(payment.processingFeeCents / 100)}` : ""}\n\nTotal  ${currency.format(payment.totalCents / 100)}${payment.cardBrand && payment.cardLastFour ? `\n${payment.cardBrand} •••• ${payment.cardLastFour}` : ""}\n`;
  return { subject: `BrickellHouse payment confirmation ${payment.transactionNumber}`, html, text };
}
