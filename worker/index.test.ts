import { describe, expect, it } from "vitest";
import { createApp } from "./index";

describe("Worker API boundaries", () => {
  it("exposes an unauthenticated health check", async () => {
    const response = await createApp().request("/api/health", {}, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runtime: "cloudflare-workers" });
  });

  it("rejects unauthenticated product and transaction access", async () => {
    const app = createApp();
    expect((await app.request("/api/products", {}, {})).status).toBe(401);
    expect((await app.request("/api/transactions", {}, {})).status).toBe(401);
    expect((await app.request("/api/accounting/summary", {}, {})).status).toBe(401);
  });

  it("keeps an unconfigured auth handler unavailable", async () => {
    const response = await createApp().request("/api/auth/ok", {}, {});
    expect(response.status).toBe(503);
  });
});
