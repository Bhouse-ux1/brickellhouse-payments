import { describe, expect, it, vi } from "vitest";
import { createApp, createScheduledHandler } from "./index";

describe("Worker API boundaries", () => {
  it("exposes an unauthenticated health check", async () => {
    const response = await createApp().request("/api/health", {}, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runtime: "cloudflare-workers" });
  });

  it("reports Terminal configured for an approved live restricted key only", async () => {
    const configured = {
      STRIPE_LIVE_MODE_ONLY: "true",
      STRIPE_SECRET_KEY: "rk_live_placeholder",
      STRIPE_TERMINAL_READER_ID: "tmr_live",
      STRIPE_TERMINAL_LOCATION_ID: "tml_live",
      STRIPE_TERMINAL_WEBHOOK_SECRET: "whsec_placeholder",
      RESEND_API_KEY: "re_placeholder",
      PAYMENT_NOTIFICATION_EMAIL: "admin@brickellhouse.net",
    };
    const liveResponse = await createApp().request("/api/health", {}, configured);
    expect(await liveResponse.json()).toMatchObject({ terminalConfigured: true, stripeMode: "live-only", managementNotificationConfigured: true });
    const testResponse = await createApp().request("/api/health", {}, { ...configured, STRIPE_SECRET_KEY: "rk_test_placeholder" });
    expect(await testResponse.json()).toMatchObject({ terminalConfigured: false });
  });

  it("rejects unauthenticated product and transaction access", async () => {
    const app = createApp();
    expect((await app.request("/api/products", {}, {})).status).toBe(401);
    expect((await app.request("/api/transactions", {}, {})).status).toBe(401);
    expect((await app.request("/api/accounting/summary", {}, {})).status).toBe(401);
  });

  it("removes temporary access and fails closed when production auth is unconfigured", async () => {
    expect((await createApp().request("/api/test-access/login", { method: "POST" }, {})).status).toBe(404);
    expect((await createApp().request("/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "staff@example.com", password: "not-a-password" }),
    }, {})).status).toBe(503);
    expect((await createApp().request("/api/admin/users", {}, {})).status).toBe(401);
  });

  it("keeps the six-hour database schedule read-only", async () => {
    const keepalive = vi.fn(async () => undefined);
    const expireDisplays = vi.fn(async () => ({ expired: 0, deferred: 0 }));
    const waitUntil = vi.fn();
    const env = { HYPERDRIVE: { connectionString: "postgresql://placeholder" } as Hyperdrive };

    createScheduledHandler(keepalive, expireDisplays)(
      { cron: "0 */6 * * *" } as ScheduledController,
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(keepalive).toHaveBeenCalledOnce();
    expect(keepalive).toHaveBeenCalledWith(env);
    expect(expireDisplays).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    await waitUntil.mock.calls[0]?.[0];
  });

  it("routes the minute maintenance schedule only to abandoned-display reconciliation", async () => {
    const keepalive = vi.fn(async () => undefined);
    const expireDisplays = vi.fn(async () => ({ expired: 0, deferred: 0 }));
    const waitUntil = vi.fn();
    const env = { HYPERDRIVE: { connectionString: "postgresql://placeholder" } as Hyperdrive };

    createScheduledHandler(keepalive, expireDisplays)(
      { cron: "* * * * *" } as ScheduledController,
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(keepalive).not.toHaveBeenCalled();
    expect(expireDisplays).toHaveBeenCalledOnce();
    expect(expireDisplays).toHaveBeenCalledWith({ env });
    await waitUntil.mock.calls[0]?.[0];
  });
});
