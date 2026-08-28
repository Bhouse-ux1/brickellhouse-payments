import { describe, expect, it } from "vitest";
import { mayReceivePasswordReset } from "./auth";

describe("password reset eligibility", () => {
  it("allows active production employee roles to complete initial setup or reset", () => {
    expect(mayReceivePasswordReset({ active: true, banned: false, role: "ADMIN" })).toBe(true);
    expect(mayReceivePasswordReset({ active: true, banned: false, role: "STAFF" })).toBe(true);
  });

  it("blocks archived, banned, and non-employee identities", () => {
    expect(mayReceivePasswordReset({ active: false, banned: true, role: "EMPLOYEE" })).toBe(false);
    expect(mayReceivePasswordReset({ active: false, banned: false, role: "ADMIN" })).toBe(false);
    expect(mayReceivePasswordReset({ active: true, banned: true, role: "STAFF" })).toBe(false);
    expect(mayReceivePasswordReset({ active: true, banned: false, role: "EMPLOYEE" })).toBe(false);
  });
});
