import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeWebhookSignature } from "./stripe-webhook";

describe("Stripe webhook signature boundary", () => {
  it("verifies the raw body and rejects body changes", async () => {
    const rawBody = '{"id":"evt_test","livemode":false}';
    const secret = "whsec_test";
    const timestamp = 1_800_000_000;
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const header = `t=${timestamp},v1=${signature}`;
    expect(await verifyStripeWebhookSignature({ rawBody, signatureHeader: header, webhookSecret: secret, nowSeconds: timestamp })).toBe(true);
    expect(await verifyStripeWebhookSignature({ rawBody: `${rawBody} `, signatureHeader: header, webhookSecret: secret, nowSeconds: timestamp })).toBe(false);
  });

  it("rejects stale events", async () => {
    expect(await verifyStripeWebhookSignature({ rawBody: "{}", signatureHeader: "t=1,v1=abc", webhookSecret: "whsec_test", nowSeconds: 1000 })).toBe(false);
  });
});
