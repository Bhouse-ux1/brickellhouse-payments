import { describe, expect, it, vi } from "vitest";
import { incidentStripeStateAllowsCancellation, recoverTerminalIncident } from "./terminal-incident-recovery";
import type { StripePaymentIntent, StripeReader } from "./stripe-client";
import { paymentAttempts, terminalReaderObservations, terminalReaders, transactions } from "@/db/schema";
import { markPaymentFailed } from "./payment-reconciliation";
vi.mock("./payment-reconciliation", () => ({ markPaymentFailed: vi.fn(async () => true) }));

const reader: StripeReader = { id: "tmr_live", object: "terminal.reader", livemode: true, location: "tml_live", status: "online", action: null };
const intent: StripePaymentIntent & { payment_method: unknown } = { id: "pi_live", object: "payment_intent", livemode: true, status: "requires_payment_method", amount: 71, currency: "usd", metadata: {}, amount_received: 0, latest_charge: null, payment_method: null };
describe("incident recovery Stripe guard", () => {
  it("accepts only explicitly empty payment evidence and an online idle Reader", () => {
    expect(incidentStripeStateAllowsCancellation(reader, intent)).toBe(true);
  });
  it.each([
    { status: "succeeded" }, { status: "processing" }, { status: "canceled" }, { status: "requires_capture" },
    { payment_method: "pm_private" }, { payment_method: undefined }, { latest_charge: "ch_private" },
    { latest_charge: undefined }, { amount_received: 1 }, { amount_received: undefined },
  ])("refuses changed or missing evidence %s", override => {
    expect(incidentStripeStateAllowsCancellation(reader, { ...intent, ...override })).toBe(false);
  });
  it.each([{ status: "offline" }, { action: { type: "set_reader_display", status: "in_progress" } }, { action: { type: "process_payment_intent", status: "in_progress" } }])("refuses non-idle Reader %s", override => {
    expect(incidentStripeStateAllowsCancellation({ ...reader, ...override }, intent)).toBe(false);
  });
});

describe("incident recovery execution", () => {
  function setup(overrides: Record<string, unknown> = {}, observationStatuses: string[] = []) {
    const id = "3971ba79-1704-4e95-a189-2857847a3075";
    const attemptId = "c6e7f64f-b300-41b4-bba9-2eb0cf00d408";
    const pi = "pi_3UG1xuH75hxIRBjq1GM9C9FR";
    const rows = new Map<unknown, unknown[]>([
      [transactions, [{ id, number: "POS-000026", paymentStatus: "SENDING_TO_TERMINAL", stripePaymentIntentId: pi, totalCents: 71 }]],
      [paymentAttempts, [{ id: attemptId, transactionId: id, terminalReaderId: "reader", status: "READER_RESERVED", stripePaymentIntentId: pi, expectedAmountCents: 71, idempotencyKey: "attempt-stable", ...overrides }]],
      [terminalReaders, [{ id: "reader", active: true, stripeLocationId: "tml_live", lockPaymentAttemptId: attemptId }]],
      [terminalReaderObservations, observationStatuses.map(status => ({ status }))],
    ]);
    const tx = { select: () => ({ from: (table: unknown) => {
      const result = Promise.resolve(rows.get(table) ?? []);
      const query = { where: () => query, limit: () => query, for: () => result, then: result.then.bind(result) };
      return query;
    } }) };
    const db = { transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) };
    const paymentIntent = { ...intent, id: pi, payment_method_types: ["card_present"], metadata: { source: "brickellhouse_terminal", attempt_id: attemptId, internal_transaction_id: id, transaction_number: "POS-000026" } };
    const stripe = { retrieveReader: vi.fn(async () => reader), retrievePaymentIntent: vi.fn(async () => paymentIntent), cancelPaymentIntent: vi.fn(async () => ({ ...paymentIntent, status: "canceled" })) };
    const env = { STRIPE_TERMINAL_READER_ID: "tmr_live", STRIPE_TERMINAL_LOCATION_ID: "tml_live" };
    return { db, stripe, env };
  }
  it("rechecks first, cancels only the pinned intent, then finalizes its existing records", async () => {
    vi.mocked(markPaymentFailed).mockClear();
    const { db, stripe, env } = setup();
    const result = await recoverTerminalIncident(db as never, env, stripe);
    expect(result.outcome).toBe("CANCELED");
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith({ paymentIntentId: "pi_3UG1xuH75hxIRBjq1GM9C9FR", idempotencyKey: "attempt-stable:cancel-intent" });
    expect(stripe.retrievePaymentIntent.mock.invocationCallOrder[0]).toBeLessThan(stripe.cancelPaymentIntent.mock.invocationCallOrder[0]);
    expect(stripe.cancelPaymentIntent.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(markPaymentFailed).mock.invocationCallOrder[0]);
  });
  it.each([{ status: "PROCESSING" }, { stripeReaderOperationId: "operation" }, { lastErrorCode: "SETUP_STARTING" }, { stripePaymentIntentId: "pi_other" }])("does nothing if the database attempt changed %s", async override => {
    vi.mocked(markPaymentFailed).mockClear();
    const { db, stripe, env } = setup(override);
    expect((await recoverTerminalIncident(db as never, env, stripe)).outcome).toBe("REFUSED");
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(markPaymentFailed).not.toHaveBeenCalled();
  });
  it("does nothing if new durable success appeared", async () => {
    const { db, stripe, env } = setup({}, ["succeeded"]);
    expect((await recoverTerminalIncident(db as never, env, stripe)).outcome).toBe("REFUSED");
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });
  it("does not mark canceled when Stripe refuses cancellation", async () => {
    vi.mocked(markPaymentFailed).mockClear();
    const { db, stripe, env } = setup();
    stripe.cancelPaymentIntent.mockRejectedValue(new Error("state changed"));
    await expect(recoverTerminalIncident(db as never, env, stripe)).rejects.toThrow();
    expect(markPaymentFailed).not.toHaveBeenCalled();
  });
});

import { createTerminalDiagnosticRoutes } from "@worker/routes/terminal-diagnostic";
vi.mock("@worker/auth", () => ({ readAuthorizedEmployee: vi.fn(async () => ({ id: "admin", role: "ADMIN", active: true })) }));
describe("incident recovery request boundary", () => {
  it("GET only presents a form and POST requires same-origin Admin access", async () => {
    const recover = vi.fn(async () => ({ outcome: "CANCELED" }) as never);
    const routes = createTerminalDiagnosticRoutes(vi.fn(), vi.fn(() => ({}) as never), recover);
    const env = { BETTER_AUTH_URL: "https://payments.example.invalid" };
    expect((await routes.request("/terminal-incident/recover", {}, env)).status).toBe(200);
    expect(recover).not.toHaveBeenCalled();
    expect((await routes.request("/terminal-incident/recover", { method: "POST" }, env)).status).toBe(403);
    expect((await routes.request("/terminal-incident/recover", { method: "POST", headers: { origin: "https://other.invalid" } }, env)).status).toBe(403);
    expect(recover).not.toHaveBeenCalled();
    expect((await routes.request("/terminal-incident/recover", { method: "POST", headers: { origin: env.BETTER_AUTH_URL } }, env)).status).toBe(200);
    expect(recover).toHaveBeenCalledOnce();
  });
});
