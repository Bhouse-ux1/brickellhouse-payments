import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { emailDeliveries, paymentAttempts, stripeEvents, terminalReaderObservations, terminalReaders, transactions } from "@/db/schema";
import { createPaymentTestDatabase } from "@worker/test-support/payment-database";
import { cancelTerminalPayment, reconcileTerminalPayment, startTerminalPayment as processTerminalPayment, showTerminalBreakdown, expireAbandonedReaderDisplays } from "./terminal-payment";
import { processStripeEvent } from "./stripe-reconciliation";
import { deliverPaidTransactionNotifications } from "./receipt-delivery";
import type { StripePaymentIntent, StripeReader, StripeTerminalClient } from "./stripe-client";

const env = { STRIPE_SECRET_KEY: "rk_live_placeholder", STRIPE_LIVE_MODE_ONLY: "true", STRIPE_TERMINAL_READER_ID: "tmr_local", STRIPE_TERMINAL_LOCATION_ID: "tml_local", PAYMENT_NOTIFICATION_EMAIL: "management@example.invalid" };
async function startTerminalPayment(input: Parameters<typeof processTerminalPayment>[0]) {
  await showTerminalBreakdown(input);
  return processTerminalPayment(input);
}

function terminal() {
  let savedCard = false;
  let presentations = 0;
  let reader: StripeReader = { id: "tmr_local", object: "terminal.reader", location: "tml_local", livemode: true, status: "online", action: null };
  const intents = new Map<string, StripePaymentIntent>();
  const creationKeys = new Map<string, string>();
  const processKeys = new Set<string>();
  const stripe = {
    retrieveReader: vi.fn(async () => structuredClone(reader)),
    retrievePaymentIntent: vi.fn(async (id: string) => structuredClone(intents.get(id)!)),
    createPaymentIntent: vi.fn(async (input: Parameters<StripeTerminalClient["createPaymentIntent"]>[0]) => {
      if (!creationKeys.has(input.idempotencyKey)) {
        const id = `pi_local_${intents.size + 1}`;
        creationKeys.set(input.idempotencyKey, id);
        intents.set(id, { id, object: "payment_intent", status: "requires_payment_method", amount: input.amountCents, amount_received: 0, currency: "usd", livemode: true,
          metadata: input.metadata, payment_method_types: ["card_present"], payment_method: null, latest_charge: null });
      }
      return structuredClone(intents.get(creationKeys.get(input.idempotencyKey)!)!);
    }),
    setReaderDisplay: vi.fn(async (input: Parameters<StripeTerminalClient["setReaderDisplay"]>[0]) => {
      reader.action = { type: "set_reader_display", status: "in_progress", set_reader_display: { type: "cart", cart: { currency: "usd", total: input.cart.totalCents,
        line_items: input.cart.lineItems.map(line => ({ description: line.description, amount: line.amountCents, quantity: line.quantity })) } } };
      return structuredClone(reader);
    }),
    processPaymentIntent: vi.fn(async (input: Parameters<StripeTerminalClient["processPaymentIntent"]>[0]) => {
      if (intents.get(input.paymentIntentId)?.status === "canceled") throw new Error("Intent canceled");
      processKeys.add(input.idempotencyKey);
      reader.action = { type: "process_payment_intent", status: "in_progress", process_payment_intent: { payment_intent: input.paymentIntentId } };
      if (savedCard) { savedCard = false; succeed(input.paymentIntentId); }
      return structuredClone(reader);
    }),
    cancelPaymentIntent: vi.fn(async (input: Parameters<StripeTerminalClient["cancelPaymentIntent"]>[0]) => {
      const intent = intents.get(input.paymentIntentId)!;
      if (intent.status === "succeeded") throw new Error("Already succeeded");
      intent.status = "canceled";
      return structuredClone(intent);
    }),
    cancelReaderAction: vi.fn(async () => { savedCard = false; reader.action = null; return structuredClone(reader); }),
  } satisfies StripeTerminalClient;
  function succeed(id: string) {
    const intent = intents.get(id)!;
    intent.status = "succeeded"; intent.amount_received = intent.amount; intent.payment_method = "pm_local";
    intent.latest_charge = { id: `ch_${id}`, object: "charge", payment_intent: id, paid: true, captured: true, livemode: true,
      amount: intent.amount, amount_captured: intent.amount, currency: "usd", payment_method_details: { card_present: { brand: "visa", last4: "4242" } } };
    reader.action = { type: "process_payment_intent", status: "succeeded", process_payment_intent: { payment_intent: id } };
  }
  return { stripe, intents, processKeys, reader: () => reader, setReader: (value: StripeReader) => { reader = value; }, succeed,
    presentations: () => presentations,
    presentCard() {
      presentations++;
      // Reader-internal state only: pre-dip changes no API response or event.
      if (reader.action?.type === "set_reader_display") savedCard = true;
      else {
        const id = reader.action?.process_payment_intent?.payment_intent;
        if (typeof id !== "string") throw new Error("No active local payment");
        succeed(id);
      }
    },
  };
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("repeated payments and SQL race regressions", { timeout: 20_000 }, () => {
  let testDb: Awaited<ReturnType<typeof createPaymentTestDatabase>>;
  beforeAll(async () => { testDb = await createPaymentTestDatabase(); }, 30_000);
  afterAll(async () => { await testDb?.client.close(); });
  beforeEach(async () => { await testDb.reset(); });
  const attemptFor = async (id: string) => (await testDb.db.select().from(paymentAttempts).where(eq(paymentAttempts.transactionId, id)))[0];
  const statusFor = async (id: string) => (await testDb.db.select().from(transactions).where(eq(transactions.id, id)))[0].paymentStatus;
  const locks = async () => (await testDb.db.select().from(terminalReaders)).filter(row => row.lockPaymentAttemptId);

  it("completes first, cancels second before a card, then starts third with distinct intent/operation identities", async () => {
    const t = terminal();
    const first = await testDb.draft();
    const input = (id: string) => ({ db: testDb.db, env, stripe: t.stripe, transactionId: id });
    expect((await startTerminalPayment(input(first.id))).paymentStatus).toBe("WAITING_FOR_CUSTOMER");
    const firstAttempt = await attemptFor(first.id);
    t.succeed(firstAttempt.stripePaymentIntentId!);
    // Real webhook finalization, followed by polling, retains exactly one pair of delivery rows.
    const event = { id: "evt_first_succeeded", object: "event" as const, type: "payment_intent.succeeded", livemode: true, data: { object: t.intents.get(firstAttempt.stripePaymentIntentId!)! } };
    await processStripeEvent({ db: testDb.db, env, stripe: t.stripe, event, rawBody: JSON.stringify(event) });
    await reconcileTerminalPayment(input(first.id));
    await processStripeEvent({ db: testDb.db, env, stripe: t.stripe, event, rawBody: JSON.stringify(event) });
    expect(await statusFor(first.id)).toBe("PAID");
    expect(await locks()).toHaveLength(0);
    expect((await testDb.db.select().from(emailDeliveries)).map(d => d.kind).sort()).toEqual(["MANAGEMENT_PAYMENT_CONFIRMATION", "RESIDENT_RECEIPT"]);
    const emailFetch = vi.fn(async () => new Response(JSON.stringify({ id: `email_${crypto.randomUUID()}` }), { status: 200 }));
    const deliveryInput = { db: testDb.db, env: { ...env, RESEND_API_KEY: "re_placeholder", EMAIL_FROM: "payments@example.invalid" }, transactionId: first.id, fetcher: emailFetch };
    await Promise.all([deliverPaidTransactionNotifications(deliveryInput), deliverPaidTransactionNotifications(deliveryInput)]);
    await deliverPaidTransactionNotifications(deliveryInput);
    expect(emailFetch).toHaveBeenCalledTimes(2);
    expect((await testDb.db.select().from(emailDeliveries)).every(row => row.status === "SENT")).toBe(true);
    // Stripe may retain the completed action; it is idle and must not block the next cart.
    const second = await testDb.draft();
    expect((await startTerminalPayment(input(second.id))).paymentStatus).toBe("WAITING_FOR_CUSTOMER");
    expect((await cancelTerminalPayment(input(second.id))).paymentStatus).toBe("CANCELED");
    expect(t.reader().action).toBeNull();
    expect(await locks()).toHaveLength(0);
    const third = await testDb.draft();
    expect((await startTerminalPayment(input(third.id))).paymentStatus).toBe("WAITING_FOR_CUSTOMER");
    expect(t.intents.size).toBe(3); expect(t.processKeys.size).toBe(3);
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledTimes(3); expect(t.stripe.processPaymentIntent).toHaveBeenCalledTimes(3);
    expect(await statusFor(first.id)).toBe("PAID");
  });

  it("a poll that read pre-intent state cannot regress a later Reader transition to READER_RESERVED", async () => {
    const t = terminal(); const draft = await testDb.draft(); const captured = deferred(); const release = deferred();
    let poll!: Promise<unknown>;
    const display = t.stripe.setReaderDisplay.getMockImplementation()!;
    t.stripe.setReaderDisplay.mockImplementation(async input => {
      const cartReader = await display(input);
      const pollStripe = { ...t.stripe, retrieveReader: async () => { captured.resolve(); await release.promise; return cartReader; } };
      poll = reconcileTerminalPayment({ db: testDb.db, env, stripe: pollStripe, transactionId: draft.id });
      await captured.promise;
      return cartReader;
    });
    await startTerminalPayment({ db: testDb.db, env, stripe: t.stripe, transactionId: draft.id });
    release.resolve(); await poll;
    expect((await attemptFor(draft.id)).status).toBe("WAITING_FOR_CUSTOMER");
    expect(await statusFor(draft.id)).toBe("WAITING_FOR_CUSTOMER");
    expect(t.stripe.processPaymentIntent).toHaveBeenCalledOnce();
  });

  it("duplicate Show Breakdown and Process Payment requests issues one intent and one process request", async () => {
    const t = terminal(); const draft = await testDb.draft(); const captured = deferred(); const release = deferred();
    const display = t.stripe.setReaderDisplay.getMockImplementation()!;
    t.stripe.setReaderDisplay.mockImplementation(async input => { captured.resolve(); await release.promise; return display(input); });
    const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    const first = startTerminalPayment(input); await captured.promise;
    await startTerminalPayment(input);
    release.resolve(); await first;
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledOnce(); expect(t.stripe.processPaymentIntent).toHaveBeenCalledOnce();
  });

  it("stuck mapped preparation exposes recovery after timeout and can cancel without another intent or Reader command", async () => {
    const t = terminal(); const draft = await testDb.draft();
    t.stripe.processPaymentIntent.mockRejectedValueOnce(new Error("No response"));
    const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await expect(startTerminalPayment(input)).rejects.toThrow();
    t.reader().action = null;
    await testDb.db.update(paymentAttempts).set({ updatedAt: new Date(Date.now() - 180_000) }).where(eq(paymentAttempts.transactionId, draft.id));
    expect((await reconcileTerminalPayment(input)).setupRecoveryRequired).toBe(true);
    expect((await cancelTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledOnce(); expect(t.stripe.processPaymentIntent).toHaveBeenCalledOnce();
    expect(t.stripe.cancelReaderAction).not.toHaveBeenCalled(); expect(await locks()).toHaveLength(0);
  });

  it("refresh during setup polls without claiming setup or duplicating Stripe operations", async () => {
    const t = terminal(); const draft = await testDb.draft(); const captured = deferred(); const release = deferred();
    const create = t.stripe.createPaymentIntent.getMockImplementation()!;
    t.stripe.createPaymentIntent.mockImplementation(async input => { captured.resolve(); await release.promise; return create(input); });
    const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    const start = startTerminalPayment(input); await captured.promise;
    expect((await reconcileTerminalPayment(input)).paymentStatus).toBe("SENDING_TO_TERMINAL");
    await expect(cancelTerminalPayment(input)).rejects.toThrow(/safely canceled/);
    expect(t.stripe.cancelReaderAction).not.toHaveBeenCalled(); expect(t.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    release.resolve(); await start;
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledOnce(); expect(t.stripe.processPaymentIntent).toHaveBeenCalledOnce();
  });

  it.each(["cart", "idle"])("safely cancels pre-intent %s setup after a known setup failure", async readerState => {
    const t = terminal(); const draft = await testDb.draft();
    const display = t.stripe.setReaderDisplay.getMockImplementation()!;
    t.stripe.setReaderDisplay.mockImplementation(async input => { if (readerState === "cart") await display(input); throw new Error("Display acknowledgement lost"); });
    const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await expect(startTerminalPayment(input)).rejects.toThrow();
    expect((await cancelTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    expect(t.stripe.createPaymentIntent).not.toHaveBeenCalled(); expect(t.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(t.stripe.cancelReaderAction).toHaveBeenCalledTimes(readerState === "cart" ? 1 : 0);
    expect(await locks()).toHaveLength(0);
  });

  it.each(["processing", "method", "charge", "other-reader-action"])("refuses uncertain cancellation: %s", async reason => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await startTerminalPayment(input); const attempt = await attemptFor(draft.id); const intent = t.intents.get(attempt.stripePaymentIntentId!)!;
    if (reason === "processing") intent.status = "processing";
    if (reason === "method") intent.payment_method = "pm_present";
    if (reason === "charge") intent.latest_charge = "ch_present";
    if (reason === "other-reader-action") t.reader().action = { type: "process_payment_intent", status: "in_progress", process_payment_intent: { payment_intent: "pi_other" } };
    await expect(cancelTerminalPayment(input)).rejects.toThrow();
    expect(t.stripe.cancelPaymentIntent).not.toHaveBeenCalled(); expect(t.stripe.cancelReaderAction).not.toHaveBeenCalled(); expect(await locks()).toHaveLength(1);
  });

  it("unexpected clearing of a submitted Reader action stays blocked", async () => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await startTerminalPayment(input); t.reader().action = null;
    await expect(reconcileTerminalPayment(input)).rejects.toThrow(/reconciliation/);
    expect(await statusFor(draft.id)).toBe("WAITING_FOR_CUSTOMER"); expect(await locks()).toHaveLength(1);
  });

  it("a success webhook racing the process response cannot be downgraded", async () => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    const process = t.stripe.processPaymentIntent.getMockImplementation()!;
    t.stripe.processPaymentIntent.mockImplementation(async request => {
      const delayedResponse = await process(request); t.succeed(request.paymentIntentId);
      await reconcileTerminalPayment(input);
      return delayedResponse;
    });
    expect((await startTerminalPayment(input)).paymentStatus).toBe("PAID");
    expect((await attemptFor(draft.id)).status).toBe("SUCCEEDED"); expect(await statusFor(draft.id)).toBe("PAID"); expect(await locks()).toHaveLength(0);
    expect(await testDb.db.select().from(emailDeliveries)).toHaveLength(2);
  });

  it("durable success evidence blocks cancellation even when the mutable Reader is idle", async () => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await startTerminalPayment(input); const attempt = await attemptFor(draft.id); t.reader().action = null;
    await testDb.db.insert(stripeEvents).values({ stripeEventId: "evt_durable", eventType: "terminal.reader.action_succeeded", liveMode: true, payloadSha256: "0".repeat(64) });
    await testDb.db.insert(terminalReaderObservations).values({ stripeEventId: "evt_durable", readerId: env.STRIPE_TERMINAL_READER_ID, locationId: env.STRIPE_TERMINAL_LOCATION_ID, liveMode: true, actionType: "process_payment_intent", actionStatus: "succeeded", stripePaymentIntentId: attempt.stripePaymentIntentId!, paymentAttemptId: attempt.id, transactionId: draft.id });
    await expect(cancelTerminalPayment(input)).rejects.toThrow(); expect(t.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("a late process response cannot restore a canceled transaction or reservation", async () => {
    const t = terminal(); const draft = await testDb.draft(); const captured = deferred(); const release = deferred();
    const process = t.stripe.processPaymentIntent.getMockImplementation()!;
    t.stripe.processPaymentIntent.mockImplementation(async request => {
      const response = await process(request); captured.resolve(); await release.promise; return response;
    });
    const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    const start = startTerminalPayment(input); await captured.promise;
    expect((await cancelTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    release.resolve(); await start;
    expect((await attemptFor(draft.id)).status).toBe("CANCELED");
    expect(await statusFor(draft.id)).toBe("CANCELED"); expect(await locks()).toHaveLength(0);
    expect(t.reader().action).toBeNull();
  });

  it("unknown intent-creation outcome stays blocked after timeout without creating another intent", async () => {
    const t = terminal(); const draft = await testDb.draft();
    const create = t.stripe.createPaymentIntent.getMockImplementation()!;
    t.stripe.createPaymentIntent.mockImplementation(async request => { await create(request); throw new Error("Response lost"); });
    const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await expect(startTerminalPayment(input)).rejects.toThrow(); t.reader().action = null;
    await testDb.db.update(paymentAttempts).set({ updatedAt: new Date(Date.now() - 180_000) }).where(eq(paymentAttempts.transactionId, draft.id));
    expect((await reconcileTerminalPayment(input)).setupRecoveryRequired).toBe(true);
    await expect(cancelTerminalPayment(input)).rejects.toThrow(/safely canceled/);
    await startTerminalPayment(input);
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledOnce(); expect(t.intents.size).toBe(1);
    expect(t.stripe.cancelPaymentIntent).not.toHaveBeenCalled(); expect(await locks()).toHaveLength(1);
  });

  it("cancels a draft before terminal setup and never activates it afterward", async () => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    expect((await cancelTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    expect((await startTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    expect(t.stripe.createPaymentIntent).not.toHaveBeenCalled(); expect(t.stripe.setReaderDisplay).not.toHaveBeenCalled(); expect(await locks()).toHaveLength(0);
  });
  it.each(["before", "after"])("one card presented %s Process Payment converges on one PAID transaction and idempotent receipts", async timing => {
    const t = terminal(); const draft = await testDb.draft();
    const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    const shown = await showTerminalBreakdown(input);
    expect(shown).toMatchObject({ breakdownReady: true, paymentStatus: "READY", displayStatus: "Resident may review the breakdown and present their card." });
    expect(t.intents.size).toBe(0); expect(t.stripe.processPaymentIntent).not.toHaveBeenCalled();
    const beforeTap = await t.stripe.retrieveReader();
    if (timing === "before") t.presentCard();
    expect(await t.stripe.retrieveReader()).toEqual(beforeTap);
    expect(await testDb.db.select().from(terminalReaderObservations)).toHaveLength(0);
    expect((await reconcileTerminalPayment(input)).breakdownReady).toBe(true);
    // A repeated display request and an allowed trusted display update preserve
    // the logical attempt and the Reader's invisible stored payment method.
    const originalAttempt = await attemptFor(draft.id);
    await showTerminalBreakdown(input);
    const displayInput = t.stripe.setReaderDisplay.mock.calls[0][0];
    await t.stripe.setReaderDisplay(displayInput);
    expect((await attemptFor(draft.id)).id).toBe(originalAttempt.id);
    await processTerminalPayment(input);
    await processTerminalPayment(input);
    if (timing === "after") t.presentCard();
    const attempt = await attemptFor(draft.id);
    const event = { id: `evt_${timing}`, object: "event" as const, type: "payment_intent.succeeded", livemode: true, data: { object: t.intents.get(attempt.stripePaymentIntentId!)! } };
    await processStripeEvent({ db: testDb.db, env, stripe: t.stripe, event, rawBody: JSON.stringify(event) });
    await reconcileTerminalPayment(input);
    await processStripeEvent({ db: testDb.db, env, stripe: t.stripe, event, rawBody: JSON.stringify(event) });
    expect(await statusFor(draft.id)).toBe("PAID"); expect(await locks()).toHaveLength(0);
    expect((await attemptFor(draft.id)).status).toBe("SUCCEEDED");
    expect(t.presentations()).toBe(1);
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledOnce(); expect(t.stripe.processPaymentIntent).toHaveBeenCalledOnce();
    expect(t.intents.size).toBe(1); expect(t.processKeys.size).toBe(1);
    expect(t.stripe.cancelReaderAction).not.toHaveBeenCalled(); expect(t.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(t.stripe.setReaderDisplay).toHaveBeenCalledTimes(2); // first display plus explicit trusted update only
    const emailFetch = vi.fn(async () => new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 }));
    const delivery = { db: testDb.db, env: { ...env, RESEND_API_KEY: "re_placeholder", EMAIL_FROM: "payments@example.invalid" }, transactionId: draft.id, fetcher: emailFetch };
    await Promise.all([deliverPaidTransactionNotifications(delivery), deliverPaidTransactionNotifications(delivery)]);
    await deliverPaidTransactionNotifications(delivery);
    expect(emailFetch).toHaveBeenCalledTimes(2);
    expect((await testDb.db.select().from(emailDeliveries)).map(row => row.kind).sort()).toEqual(["MANAGEMENT_PAYMENT_CONFIRMATION", "RESIDENT_RECEIPT"]);
  });

  it("preserves an invisible pre-dip across a long review, polling, scheduled cleanup and expired reservation", async () => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await showTerminalBreakdown(input); t.presentCard();
    const old = new Date(Date.now() - 3_600_000);
    await testDb.db.update(paymentAttempts).set({ updatedAt: old }).where(eq(paymentAttempts.transactionId, draft.id));
    await testDb.db.update(terminalReaders).set({ lockExpiresAt: old });
    expect(await expireAbandonedReaderDisplays(input)).toEqual({ expired: 0, deferred: 0 });
    expect(await reconcileTerminalPayment(input)).toMatchObject({ breakdownReady: true, setupRecoveryRequired: false });
    const other = await testDb.draft();
    await expect(showTerminalBreakdown({ ...input, transactionId: other.id })).rejects.toThrow(/reserved/);
    await processTerminalPayment(input); await reconcileTerminalPayment(input);
    expect(await statusFor(draft.id)).toBe("PAID"); expect(t.presentations()).toBe(1);
    expect(t.stripe.setReaderDisplay).toHaveBeenCalledOnce(); expect(t.stripe.processPaymentIntent).toHaveBeenCalledOnce();
    expect(t.stripe.cancelReaderAction).not.toHaveBeenCalled();
  });

  it.each([false, true])("explicit Cancel before processing clears the display and abandons with no PI (pre-dip=%s)", async preDip => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await showTerminalBreakdown(input); if (preDip) t.presentCard();
    expect((await cancelTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    expect(await statusFor(draft.id)).toBe("CANCELED"); expect(await locks()).toHaveLength(0);
    expect(t.stripe.cancelReaderAction).toHaveBeenCalledOnce(); expect(t.reader().action).toBeNull();
    expect(t.stripe.createPaymentIntent).not.toHaveBeenCalled(); expect(t.stripe.processPaymentIntent).not.toHaveBeenCalled();
    expect((await processTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    expect(await testDb.db.select().from(emailDeliveries)).toHaveLength(0);
  });

  it("refuses Process Payment before a trusted breakdown is acknowledged", async () => {
    const t = terminal(); const draft = await testDb.draft();
    await expect(processTerminalPayment({ db: testDb.db, env, stripe: t.stripe, transactionId: draft.id })).rejects.toThrow(/Show Breakdown/);
    expect(t.stripe.createPaymentIntent).not.toHaveBeenCalled(); expect(t.stripe.setReaderDisplay).not.toHaveBeenCalled();
  });

  it.each(["before-create", "after-create"])("refuses a displayed total mismatch %s without processing or resetting the Reader", async timing => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await showTerminalBreakdown(input);
    const corrupt = () => { t.reader().action!.set_reader_display!.cart!.total! += 1; };
    if (timing === "before-create") corrupt();
    else {
      const create = t.stripe.createPaymentIntent.getMockImplementation()!;
      t.stripe.createPaymentIntent.mockImplementation(async request => { const intent = await create(request); corrupt(); return intent; });
    }
    await expect(processTerminalPayment(input)).rejects.toThrow();
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledTimes(timing === "before-create" ? 0 : 1);
    expect(t.stripe.processPaymentIntent).not.toHaveBeenCalled(); expect(t.stripe.setReaderDisplay).toHaveBeenCalledOnce();
    expect(t.stripe.cancelReaderAction).not.toHaveBeenCalled(); expect(await locks()).toHaveLength(1);
  });

  it("a Cancel that wins the pre-payment claim prevents a concurrent Process Payment from creating an intent", async () => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    await showTerminalBreakdown(input); t.presentCard();
    const captured = deferred(); const release = deferred(); const oldReader = structuredClone(t.reader());
    t.stripe.retrieveReader.mockImplementationOnce(async () => { captured.resolve(); await release.promise; return oldReader; });
    const pending = processTerminalPayment(input); await captured.promise;
    expect((await cancelTerminalPayment(input)).paymentStatus).toBe("CANCELED");
    release.resolve(); expect((await pending).paymentStatus).toBe("CANCELED");
    expect(t.stripe.createPaymentIntent).not.toHaveBeenCalled(); expect(t.stripe.processPaymentIntent).not.toHaveBeenCalled();
    expect(await locks()).toHaveLength(0); expect(t.reader().action).toBeNull();
  });

  it.each(["process", "cancel"])("an acknowledged successful display permits %s without mistaking display success for payment success", async next => {
    const t = terminal(); const draft = await testDb.draft(); const input = { db: testDb.db, env, stripe: t.stripe, transactionId: draft.id };
    const display = t.stripe.setReaderDisplay.getMockImplementation()!;
    t.stripe.setReaderDisplay.mockImplementation(async request => { await display(request); t.reader().action!.status = "succeeded"; return structuredClone(t.reader()); });
    expect((await showTerminalBreakdown(input)).breakdownReady).toBe(true);
    t.presentCard();
    if (next === "process") {
      await processTerminalPayment(input); await reconcileTerminalPayment(input);
      expect(await statusFor(draft.id)).toBe("PAID");
    } else {
      expect((await cancelTerminalPayment(input)).paymentStatus).toBe("CANCELED");
      expect(t.stripe.createPaymentIntent).not.toHaveBeenCalled();
    }
    expect(await locks()).toHaveLength(0);
  });

});
