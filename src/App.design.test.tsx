// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { PaymentAction } from "./ui/interface";
import { productCatalog } from "./domain/products/catalog";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe("redesigned payment controls", () => {
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
