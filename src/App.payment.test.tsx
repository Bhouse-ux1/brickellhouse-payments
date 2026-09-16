// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { productCatalog } from "./domain/products/catalog";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function mockApi(initialStatus = "SENDING_TO_TERMINAL") {
  const statuses = new Map([["first", initialStatus]]);
  let count = 1;
  let activate: (() => Promise<Response>) | undefined;
  let cancel: (() => Promise<Response>) | undefined;
  let recovery = false;
  const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = String(request);
    if (path === "/api/session") return json({ employee: { name: "Test Admin", role: "ADMIN" } });
    if (path === "/api/products") return json({ products: productCatalog.filter(p => p.id === "black_white_printing") });
    if (path === "/api/transactions" && init?.method === "POST") {
      const id = `transaction-${++count}`; statuses.set(id, "SENDING_TO_TERMINAL"); return json({ transaction: { id } });
    }
    const id = path.split("/")[3];
    if (path.endsWith("/cancel")) {
      if (cancel) return cancel();
      statuses.set(id, "CANCELED"); return json({ paymentStatus: "CANCELED" });
    }
    if (path.endsWith("/payment-attempts")) {
      if (activate) return activate();
      statuses.set(id, "WAITING_FOR_CUSTOMER"); return json({ paymentStatus: "WAITING_FOR_CUSTOMER", displayStatus: "Waiting for card" });
    }
    if (path.endsWith("/reconcile")) return json({ paymentStatus: statuses.get(id), displayStatus: "Preparing terminal" });
    if (path.startsWith("/api/transactions/")) return json({
      transaction: { unitNumber: "TEST", customerEmail: "resident@example.invalid", totalCents: 71, cardBrand: "visa", cardLastFour: "4242" },
      items: [{ productId: "black_white_printing", productNameSnapshot: "Black & White Printing", quantity: 4, unitPriceCentsSnapshot: 10 }],
      payment: { status: statuses.get(id), displayStatus: recovery ? "Terminal setup needs attention. Select Cancel to check whether it can be canceled." : statuses.get(id),
        readerDisplayPending: statuses.get(id) === "SENDING_TO_TERMINAL", setupRecoveryRequired: recovery, recoveryRequired: false },
    });
    throw new Error(`Unexpected local test request: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, statuses, setActivation: (fn: () => Promise<Response>) => { activate = fn; }, setCancel: (fn: () => Promise<Response>) => { cancel = fn; }, showRecovery: () => { recovery = true; } };
}
function mount() { render(<MemoryRouter><App /></MemoryRouter>); }
async function fillAndCharge() {
  fireEvent.change(await screen.findByLabelText("Unit number"), { target: { value: "NEXT" } });
  fireEvent.change(screen.getByLabelText("Resident email"), { target: { value: "next@example.invalid" } });
  fireEvent.click(await screen.findByRole("button", { name: /Black & White Printing/ }));
  fireEvent.change(screen.getByLabelText("Black & White Printing quantity"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Charge $0.71" }));
  await screen.findByRole("button", { name: "Cancel" });
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
describe("employee payment lifecycle (local mocked DOM)", () => {
  it("clears the first paid cart, cancels the second, and starts a third clean transaction", async () => {
    const api = mockApi("PAID"); sessionStorage.setItem("bh_active_transaction", "first"); mount();
    await screen.findByText("Payment successful", { selector: "strong" });
    expect((screen.getByLabelText("Unit number") as HTMLInputElement).value).toBe("");
    expect(sessionStorage.getItem("bh_active_transaction")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New Transaction" }));
    await fillAndCharge();
    await waitFor(() => expect(api.statuses.get("transaction-2")).toBe("WAITING_FOR_CUSTOMER"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Payment canceled.");
    expect(sessionStorage.getItem("bh_active_transaction")).toBeNull();
    expect((screen.getByLabelText("Resident email") as HTMLInputElement).value).toBe("");
    await fillAndCharge();
    await waitFor(() => expect(api.statuses.get("transaction-3")).toBe("WAITING_FOR_CUSTOMER"));
    expect(api.fetcher.mock.calls.filter(([path]) => String(path).endsWith("/payment-attempts"))).toHaveLength(2);
  });
  it("keeps Cancel usable during a pending activation and ignores its late response after cancellation", async () => {
    const api = mockApi(); let complete!: (response: Response) => void;
    api.setActivation(() => new Promise(resolve => { complete = resolve; })); mount();
    await fillAndCharge();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Payment canceled.");
    await act(async () => { complete(json({ paymentStatus: "WAITING_FOR_CUSTOMER", displayStatus: "Late stale response" })); });
    expect(screen.queryByText("Late stale response")).toBeNull();
    expect(sessionStorage.getItem("bh_active_transaction")).toBeNull();
    expect((screen.getByLabelText("Unit number") as HTMLInputElement).value).toBe("");
  });
  it("does not clear an active cart when Cancel returns a nonterminal response", async () => {
    const api = mockApi(); api.setCancel(async () => json({ paymentStatus: "SENDING_TO_TERMINAL", displayStatus: "Still checking" }));
    sessionStorage.setItem("bh_active_transaction", "first"); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await screen.findByText("Still checking");
    expect(sessionStorage.getItem("bh_active_transaction")).toBe("first");
  });
  it("refresh shows stuck-setup guidance and retains the cart on uncertain cancellation", async () => {
    const api = mockApi(); api.showRecovery(); api.setCancel(async () => json({ error: "Reconciliation is required." }, 503));
    sessionStorage.setItem("bh_active_transaction", "first"); mount();
    await screen.findByRole("button", { name: "Terminal needs attention" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Reconciliation is required.");
    expect(sessionStorage.getItem("bh_active_transaction")).toBe("first");
    expect((screen.getByLabelText("Unit number") as HTMLInputElement).disabled).toBe(true);
  });
});
