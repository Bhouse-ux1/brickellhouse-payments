import { describe, expect, it } from "vitest";
import { authorizeEmployee } from "./authorization";

describe("employee authorization", () => {
  it("rejects unauthenticated and inactive users", () => {
    expect(authorizeEmployee(null)).toBe("AUTHENTICATION_REQUIRED");
    expect(authorizeEmployee({ active: false, role: "STAFF" })).toBe("AUTHENTICATION_REQUIRED");
  });
  it("enforces role restrictions", () => {
    expect(authorizeEmployee({ active: true, role: "STAFF" }, ["ADMIN"])).toBe("FORBIDDEN");
    expect(authorizeEmployee({ active: true, role: "ADMIN" }, ["ADMIN"])).toBe("AUTHORIZED");
  });
});
