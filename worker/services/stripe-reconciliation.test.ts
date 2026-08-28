import { describe, expect, it, vi } from "vitest";
import { decideReconciliation, processStripeEvent } from "./stripe-reconciliation";

describe("Stripe reconciliation decisions", () => {
  it("requires exact received amount before success", () => {
    expect(decideReconciliation({ eventType: "payment_intent.succeeded", paymentIntentStatus: "succeeded", amountReceived: 10_000, expectedAmountCents: 10_000 })).toBe("SUCCEEDED");
    expect(decideReconciliation({ eventType: "payment_intent.succeeded", paymentIntentStatus: "succeeded", amountReceived: 9_999, expectedAmountCents: 10_000 })).toBe("PROCESSING");
  });

  it("handles declined and canceled reader results", () => {
    expect(decideReconciliation({ eventType: "terminal.reader.action_failed", paymentIntentStatus: "requires_payment_method", expectedAmountCents: 10_000, failureCode: "card_declined" })).toBe("FAILED");
    expect(decideReconciliation({ eventType: "terminal.reader.action_failed", paymentIntentStatus: "canceled", expectedAmountCents: 10_000, failureCode: "customer_canceled" })).toBe("CANCELED");
  });

  it("keeps an uncertain timeout in reconciliation", () => {
    expect(decideReconciliation({ eventType: "terminal.reader.action_failed", paymentIntentStatus: "processing", expectedAmountCents: 10_000, failureCode: "connection_error" })).toBe("PROCESSING");
  });

  it("ignores a duplicate event before any Stripe action", async () => {
    const hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("{}")));
    const payloadSha256 = [...hashBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const returning = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockResolvedValue([{ id: "row-1", payloadSha256, processedAt: new Date() }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = {
      insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) })),
      select: vi.fn(() => ({ from })),
    };
    const stripe = { retrievePaymentIntent: vi.fn() };
    const result = await processStripeEvent({
      db: db as never,
      env: {} as never,
      rawBody: "{}",
      event: { id: "evt_duplicate", object: "event", type: "payment_intent.succeeded", livemode: true, data: { object: {} } },
      stripe: stripe as never,
    });
    expect(result).toEqual({ received: true, duplicate: true });
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("records reader-display webhooks as ignored instead of treating them as payment events", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "row-display" }]);
    const where = vi.fn().mockResolvedValue([]);
    const set = vi.fn(() => ({ where }));
    const db = {
      insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) })),
      update: vi.fn(() => ({ set })),
    };
    const result = await processStripeEvent({
      db: db as never,
      env: {} as never,
      rawBody: "display-event",
      event: {
        id: "evt_display", object: "event", type: "terminal.reader.action_succeeded", livemode: true,
        data: { object: { id: "tmr_live", object: "terminal.reader", action: { type: "set_reader_display", status: "succeeded" } } },
      },
      stripe: { retrievePaymentIntent: vi.fn() } as never,
    });
    expect(result).toEqual({ received: true, ignored: true });
    expect(db.update).toHaveBeenCalledOnce();
  });
});
