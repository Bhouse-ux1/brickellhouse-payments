import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthorizedEmployee } from "@worker/auth";
import { createTerminalDiagnosticRoutes } from "./terminal-diagnostic";

vi.mock("@worker/auth", () => ({ readAuthorizedEmployee: vi.fn() }));
const auth = vi.mocked(readAuthorizedEmployee);

describe("temporary Admin read-only diagnostic", () => {
  beforeEach(() => auth.mockReset());
  const setup = () => {
    const read = vi.fn(async () => ({ readOnly: true, decision: "RECONCILIATION_REQUIRED" }) as never);
    const db = vi.fn(() => ({}) as never);
    return { read, db, routes: createTerminalDiagnosticRoutes(read, db) };
  };
  it.each([null, { id: "staff", role: "STAFF", name: "Staff", email: "staff@example.invalid", active: true }])("rejects non-Admin access before any diagnostic reads: %s", async employee => {
    auth.mockResolvedValue(employee as Awaited<ReturnType<typeof readAuthorizedEmployee>>);
    const { routes, read, db } = setup();
    const response = await routes.request("/terminal-incident");
    expect(response.status).toBe(employee ? 403 : 401);
    expect(read).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("permits an authorized Admin GET and disables caching", async () => {
    auth.mockResolvedValue({ id: "admin", role: "ADMIN", name: "Admin", email: "admin@example.invalid", active: true });
    const { routes, read } = setup();
    const response = await routes.request("/terminal-incident");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenCalledOnce();
  });
  it("does not accept POST or arbitrary incident paths", async () => {
    auth.mockResolvedValue({ id: "admin", role: "ADMIN", name: "Admin", email: "admin@example.invalid", active: true });
    const { routes, read } = setup();
    expect((await routes.request("/terminal-incident", { method: "POST" })).status).toBe(404);
    expect((await routes.request("/terminal-incident/other")).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it("never returns raw provider error content", async () => {
    auth.mockResolvedValue({ id: "admin", role: "ADMIN", name: "Admin", email: "admin@example.invalid", active: true });
    const { routes, read } = setup();
    read.mockRejectedValue(new Error("client_secret=do-not-return; authorization=do-not-return"));
    const response = await routes.request("/terminal-incident");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Read-only diagnostic unavailable", decision: "RECONCILIATION_REQUIRED" });
  });
});
