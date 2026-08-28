import { describe, expect, it } from "vitest";
import { createApp } from "./index";

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
    };
    const liveResponse = await createApp().request("/api/health", {}, configured);
    expect(await liveResponse.json()).toMatchObject({ terminalConfigured: true, stripeMode: "live-only" });
    const testResponse = await createApp().request("/api/health", {}, { ...configured, STRIPE_SECRET_KEY: "rk_test_placeholder" });
    expect(await testResponse.json()).toMatchObject({ terminalConfigured: false });
  });

  it("rejects unauthenticated product and transaction access", async () => {
    const app = createApp();
    expect((await app.request("/api/products", {}, {})).status).toBe(401);
    expect((await app.request("/api/transactions", {}, {})).status).toBe(401);
    expect((await app.request("/api/accounting/summary", {}, {})).status).toBe(401);
  });

  it("removes the Microsoft auth handler and fails closed when test access is unconfigured", async () => {
    expect((await createApp().request("/api/auth/ok", {}, {})).status).toBe(404);
    const response = await createApp().request("/api/test-access/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "not-configured" }),
    }, {});
    expect(response.status).toBe(503);
  });
});
