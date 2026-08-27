const SIGNATURE_TOLERANCE_SECONDS = 300;

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function verifyStripeWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string;
  webhookSecret: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const values = input.signatureHeader.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = Number(values.find(([key]) => key === "t")?.[1]);
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS || !signatures.length) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(input.webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${input.rawBody}`)));
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}
