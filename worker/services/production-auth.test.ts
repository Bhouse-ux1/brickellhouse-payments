import { describe, expect, it } from "vitest";
import { INACTIVITY_TIMEOUT_SECONDS, LOGIN_RATE_LIMIT, productionAuthConfigured } from "./production-auth";

describe("production authentication policy", () => {
  it("requires a strong secret and HTTPS origin", () => {
    expect(productionAuthConfigured({ BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "https://payments.example.com" })).toBe(true);
    expect(productionAuthConfigured({ BETTER_AUTH_SECRET: "short", BETTER_AUTH_URL: "https://payments.example.com" })).toBe(false);
    expect(productionAuthConfigured({ BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "http://payments.example.com" })).toBe(false);
  });

  it("uses a practical 30-minute inactivity session and distributed login limit", () => {
    expect(INACTIVITY_TIMEOUT_SECONDS).toBe(1_800);
    expect(LOGIN_RATE_LIMIT).toEqual({ window: 300, max: 5 });
  });
});
