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
  it.each(["Black & White Printing", "Color Printing"])("supports printing boundaries in both product and cart controls: %s", async name => {
    const fetcher = mockCatalog();
    const add = await screen.findByRole("button", { name: `Add ${name}` });
    const input = screen.getByRole("spinbutton", { name: `Quantity to add for ${name}` }) as HTMLInputElement;
    expect(input.max).toBe("1000");
    const price = productCatalog.find(p => p.displayName === name)!.priceCents;
    for (const quantity of [1, 99, 100, 999, 1000]) {
      fireEvent.focus(input); fireEvent.change(input, { target: { value: "" } }); expect(input.value).toBe("");
      fireEvent.change(input, { target: { value: String(quantity) } }); fireEvent.blur(input); fireEvent.click(add);
      const cart = screen.getByLabelText(`${name} quantity`) as HTMLInputElement;
      expect(cart.max).toBe("1000"); expect(cart.value).toBe(String(quantity));
      fireEvent.focus(cart); fireEvent.change(cart, { target: { value: "" } }); expect(cart.value).toBe("");
      expect(document.querySelector(".line>b")?.textContent).toBe(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(price * quantity / 100));
      fireEvent.keyDown(cart, { key: "Enter" }); expect(cart.value).toBe(String(quantity));
      fireEvent.change(cart, { target: { value: "1001" } }); fireEvent.blur(cart); expect(cart.value).toBe(String(quantity));
      if (quantity === 1000) {
        expect((screen.getByLabelText(`Increase ${name} quantity`) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByLabelText(`Decrease ${name} quantity`)); expect(cart.value).toBe("999");
        fireEvent.click(screen.getByLabelText(`Increase ${name} quantity`)); expect(cart.value).toBe("1000");
      }
      fireEvent.click(screen.getByRole("button", { name: `Remove ${name}` }));
      expect(screen.queryByLabelText(`${name} quantity`)).toBeNull();
    }
    fireEvent.change(input, { target: { value: "1001" } }); fireEvent.blur(input); expect(input.value).toBe("1000");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps every other product at 99 and removes unnecessary interface labels", async () => {
    mockCatalog(); await screen.findByRole("button", { name: "Add Parking Fob" });
    for (const product of productCatalog.filter(p => p.category !== "Printing")) {
      expect((screen.getByRole("spinbutton", { name: `Quantity to add for ${product.displayName}` }) as HTMLInputElement).max).toBe("99");
    }
    expect(screen.queryByText(/employee use only|internal use only|live payments/i)).toBeNull();
  });

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
    const add = await screen.findByRole("button", { name: "Add Parking Fob" });
    const quantity = screen.getByRole("spinbutton", { name: "Quantity to add for Parking Fob" }) as HTMLInputElement;
    fireEvent.change(quantity, { target: { value: "9" } });
    expect(screen.queryByLabelText("Parking Fob quantity")).toBeNull();
    fireEvent.click(add);
    expect((screen.getByLabelText("Parking Fob quantity") as HTMLInputElement).value).toBe("9");
    fireEvent.change(quantity, { target: { value: "0" } }); fireEvent.blur(quantity); expect(quantity.value).toBe("9");
    fireEvent.change(quantity, { target: { value: "100" } }); fireEvent.blur(quantity); expect(quantity.value).toBe("9");
    fireEvent.change(quantity, { target: { value: "99" } }); fireEvent.click(add);
    expect((screen.getByLabelText("Parking Fob quantity") as HTMLInputElement).value).toBe("99");
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
