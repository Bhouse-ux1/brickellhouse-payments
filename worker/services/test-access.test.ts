import { describe, expect, it } from "vitest";
import {
  TEST_ACCESS_COOKIE, createTestAccessCookie, readTestAccessSession,
  verifyTestAccessPassword,
} from "./test-access";

const env = { TEST_ACCESS_PASSWORD: "temporary-password", TEST_SESSION_SECRET: "a-secure-session-secret-that-is-long-enough" };

describe("temporary test access", () => {
  it("validates the configured password without exposing it", async () => {
    expect(await verifyTestAccessPassword("temporary-password", env)).toBe(true);
    expect(await verifyTestAccessPassword("wrong", env)).toBe(false);
  });

  it("issues and verifies a secure expiring HttpOnly session cookie", async () => {
    const cookie = await createTestAccessCookie(env, 1_000);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const request = new Request("https://payments.example.test", { headers: { cookie: cookie.split(";", 1)[0] } });
    expect((await readTestAccessSession(request, env, 1_001))?.id).toBe("brickellhouse-test-employee");
    expect(await readTestAccessSession(request, env, 100_000)).toBeNull();
  });

  it("rejects a tampered session", async () => {
    const cookie = await createTestAccessCookie(env, 1_000);
    const token = cookie.split(";", 1)[0].slice(TEST_ACCESS_COOKIE.length + 1);
    const request = new Request("https://payments.example.test", { headers: { cookie: `${TEST_ACCESS_COOKIE}=${token}x` } });
    expect(await readTestAccessSession(request, env, 1_001)).toBeNull();
  });
});
