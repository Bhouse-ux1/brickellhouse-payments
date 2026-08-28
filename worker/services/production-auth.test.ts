import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getAuthTables } from "better-auth/db";
import { admin } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { accounts, rateLimits, sessions, users, verifications } from "@/db/schema";
import {
  INACTIVITY_TIMEOUT_SECONDS, LOGIN_RATE_LIMIT, PUBLIC_SIGNUP_ENABLED, productionAuthConfigured,
} from "./production-auth";

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

  it("keeps public signup disabled", () => {
    expect(PUBLIC_SIGNUP_ENABLED).toBe(false);
  });

  it("contains every field required by the installed Better Auth schema", () => {
    const required = getAuthTables({
      user: { additionalFields: { active: { type: "boolean", defaultValue: true, input: false } } },
      rateLimit: { storage: "database", modelName: "rateLimit" },
      plugins: [admin()],
    });
    const actual = { user: users, session: sessions, account: accounts, verification: verifications, rateLimit: rateLimits };
    for (const [model, table] of Object.entries(actual)) {
      const actualFields = getTableColumns(table);
      for (const field of Object.keys(required[model]!.fields)) expect(actualFields).toHaveProperty(field);
    }
    expect(getTableColumns(accounts).issuer.notNull).toBe(true);
    const accountIndexes = getTableConfig(accounts).indexes;
    expect(accountIndexes.some((index) => index.config.unique
      && index.config.columns.map((column) => ("name" in column ? column.name : "")).join(",") === "issuer,account_id")).toBe(true);
    const verificationIndexes = getTableConfig(verifications).indexes;
    expect(verificationIndexes.some((index) => !index.config.unique
      && index.config.columns.map((column) => ("name" in column ? column.name : "")).join(",") === "identifier")).toBe(true);
  });
});
