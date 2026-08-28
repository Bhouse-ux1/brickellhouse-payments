import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ createDatabase: vi.fn() }));
vi.mock("@worker/auth", () => ({
  readAuthorizedEmployee: vi.fn(async () => ({
    id: "employee-1",
    name: "Test Employee",
    email: "employee@example.invalid",
    role: "EMPLOYEE",
    active: true,
  })),
}));

import { createDatabase } from "@/db/client";
import { productRoutes } from "./products";

const catalogRows = [{
  id: "parking_fob",
  displayName: "Parking Fob",
  priceCents: 5500,
  active: true,
  terminalEnabled: true,
  quantityAllowed: true,
  category: "Access",
}];

describe("product catalog route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 503 when database access is unavailable", async () => {
    vi.mocked(createDatabase).mockReturnValue(null);
    const response = await productRoutes.request("/", {}, {});
    expect(response.status).toBe(503);
  });

  it("returns the database-backed terminal catalog without GL codes", async () => {
    const orderBy = vi.fn().mockResolvedValue(catalogRows);
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    vi.mocked(createDatabase).mockReturnValue({ select } as never);

    const response = await productRoutes.request("/", {}, {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ products: catalogRows });
    expect(select).toHaveBeenCalledOnce();
    expect(JSON.stringify(catalogRows)).not.toContain("glCode");
  });
});
