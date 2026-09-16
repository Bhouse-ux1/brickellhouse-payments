// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ClearedPaymentAnnouncement, PaymentAction } from "./ui/interface";
import { productCatalog } from "./domain/products/catalog";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function mockCatalog() {
  const fetcher = vi.fn(async (request: RequestInfo | URL) => {
    if (String(request) === "/api/session") return Response.json({ employee: { name: "Local Employee", role: "ADMIN" } });
    if (String(request) === "/api/products") return Response.json({ products: productCatalog });
    throw new Error(`Unexpected request: ${request}`);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><App/></MemoryRouter>);
  return fetcher;
}

describe("redesigned payment controls", () => {
  it("keeps the untouched and emptied cart neutral, with no minimum sweep", async () => {
    const fetcher = mockCatalog();
    const add = await screen.findByRole("button", { name: "Add Black & White Printing" });
    expect(screen.getByText("Add a charge to continue.")).toBeTruthy();
    expect(document.querySelector("[data-minimum-blocked]")).toBeNull();
    expect(screen.queryByText("Minimum payment is $0.50.")).toBeNull();
    fireEvent.click(add);
    expect(document.querySelector("[data-minimum-blocked]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Black & White Printing" }));
    expect(document.querySelector("[data-minimum-blocked]")).toBeNull();
    expect(screen.getByText("Add a charge to continue.")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stages typed product quantities until Add and preserves the cart's 1–99 limit", async () => {
    const fetcher = mockCatalog();
    const add = await screen.findByRole("button", { name: "Add Black & White Printing" });
    const quantity = screen.getByRole("spinbutton", { name: "Quantity to add for Black & White Printing" }) as HTMLInputElement;
    fireEvent.change(quantity, { target: { value: "9" } });
    expect(screen.queryByLabelText("Black & White Printing quantity")).toBeNull();
    fireEvent.click(add);
    expect((screen.getByLabelText("Black & White Printing quantity") as HTMLInputElement).value).toBe("9");
    fireEvent.change(quantity, { target: { value: "0" } }); expect(quantity.value).toBe("9");
    fireEvent.change(quantity, { target: { value: "100" } }); expect(quantity.value).toBe("9");
    fireEvent.change(quantity, { target: { value: "99" } }); fireEvent.click(add);
    expect((screen.getByLabelText("Black & White Printing quantity") as HTMLInputElement).value).toBe("99");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a fully canceled cart to neutral visual guidance", async () => {
    sessionStorage.setItem("bh_active_transaction", "local-canceled");
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const path = String(request);
      if (path === "/api/session") return Response.json({ employee: { name: "Local Employee", role: "ADMIN" } });
      if (path === "/api/products") return Response.json({ products: productCatalog });
      if (path.endsWith("/reconcile")) return Response.json({ paymentStatus: "CANCELED" });
      if (path === "/api/transactions/local-canceled") return Response.json({ transaction: { unitNumber: "LOCAL", customerEmail: "local@example.invalid" }, items: [], payment: { status: "CANCELED", displayStatus: "Payment canceled." } });
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(<MemoryRouter><App/></MemoryRouter>);
    await waitFor(() => expect(sessionStorage.getItem("bh_active_transaction")).toBeNull());
    expect(document.querySelector(".summary>.notice")).toBeNull();
    expect(document.querySelector(".paymentPhase")).toBeNull();
    expect(document.querySelector("[data-minimum-blocked]")).toBeNull();
    expect(screen.getByText("Add a charge to continue.")).toBeTruthy();
  });

  it("expires the screen-reader-only cancellation announcement", () => {
    vi.useFakeTimers(); render(<ClearedPaymentAnnouncement/>);
    expect(screen.getByRole("status").className).toBe("srOnly");
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a sub-minimum transaction disabled on hover, click and keyboard activation", async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const path = String(request);
      if (path === "/api/session") return Response.json({ employee: { name: "Local Employee", role: "ADMIN" } });
      if (path === "/api/products") return Response.json({ products: productCatalog });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<MemoryRouter><App/></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText("Unit number"), { target: { value: "LOCAL" } });
    fireEvent.change(screen.getByLabelText("Resident email"), { target: { value: "resident@example.invalid" } });
    fireEvent.click(await screen.findByRole("button", { name: /Black & White Printing/ }));
    const button = screen.getByRole("button", { name: "Show Breakdown" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const wrapper = button.parentElement!;
    expect(wrapper.getAttribute("role")).toBeNull();
    expect(wrapper.tabIndex).toBe(-1);
    fireEvent.mouseEnter(wrapper); fireEvent.click(wrapper); fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" }); fireEvent.keyUp(button, { key: " " });
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Minimum payment is $0.50.");
    expect(fetcher.mock.calls.every(([path]) => ["/api/session", "/api/products"].includes(String(path)))).toBe(true);
    fireEvent.change(screen.getByLabelText("Black & White Printing quantity"), { target: { value: "2" } });
    expect(button.disabled).toBe(false);
    expect(screen.queryByText("Minimum payment is $0.50.")).toBeNull();
  });

  it.each([
    { label: "Show Breakdown", disabled: false, busy: false, success: false, recovery: false },
    { label: "Process Payment", disabled: false, busy: false, success: false, recovery: false },
    { label: "Showing breakdown", disabled: true, busy: true, success: false, recovery: false },
    { label: "Processing payment", disabled: true, busy: true, success: false, recovery: false },
    { label: "Payment successful", disabled: true, busy: false, success: true, recovery: false },
    { label: "Terminal needs attention", disabled: true, busy: false, success: false, recovery: true },
    { label: "Checking cancellation…", disabled: true, busy: true, success: false, recovery: false },
  ])("preserves the accessible label and native action state: $label", props => {
    const action = vi.fn();
    render(<PaymentAction {...props} minimumBlocked={false} onClick={action}/>);
    const button = screen.getByRole("button", { name: props.label }) as HTMLButtonElement;
    expect(button.disabled).toBe(props.disabled);
    expect(button.getAttribute("aria-busy")).toBe(String(props.busy));
    fireEvent.click(button);
    expect(action).toHaveBeenCalledTimes(props.disabled ? 0 : 1);
  });
});
