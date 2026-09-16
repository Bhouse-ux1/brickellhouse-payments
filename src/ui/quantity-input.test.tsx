// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QuantityInput } from "./quantity-input";

afterEach(cleanup);
function Harness({ maximum }: { maximum: number }) {
  const [quantity, setQuantity] = useState(1);
  return <><QuantityInput label="Quantity" value={quantity} maximum={maximum} disabled={false} onValueChange={setQuantity}/><output aria-label="Committed quantity">{quantity}</output><button onClick={() => setQuantity(q => Math.min(maximum, q + 1))}>Plus</button><button onClick={() => setQuantity(q => Math.max(1, q - 1))}>Minus</button></>;
}

describe.each([99, 1000])("quantity text editing with maximum %i", maximum => {
  it("allows deleting the entire value, then typing a new quantity without committing an empty value", () => {
    render(<Harness maximum={maximum}/>);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe(""); expect(screen.getByLabelText("Committed quantity").textContent).toBe("1");
    fireEvent.change(input, { target: { value: "50" } });
    expect(input.value).toBe("50"); expect(screen.getByLabelText("Committed quantity").textContent).toBe("50");
    fireEvent.change(input, { target: { value: "" } }); fireEvent.blur(input);
    expect(input.value).toBe("50");
  });

  it.each(["", "0", "-1", "2.5", String(maximum + 1)])("normalizes '%s' on Enter and blur without committing it", text => {
    render(<Harness maximum={maximum}/>);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: "9" } });
    fireEvent.change(input, { target: { value: text } });
    expect(screen.getByLabelText("Committed quantity").textContent).toBe("9");
    fireEvent.keyDown(input, { key: "Enter" }); expect(input.value).toBe("9");
    fireEvent.change(input, { target: { value: text } }); fireEvent.blur(input); expect(input.value).toBe("9");
  });

  it("synchronizes stepper changes and never revives an old empty editing buffer", () => {
    render(<Harness maximum={maximum}/>);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: "50" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByText("Plus")); expect(input.value).toBe("51");
    fireEvent.click(screen.getByText("Minus")); expect(input.value).toBe("50");
    fireEvent.change(input, { target: { value: String(maximum) } });
    fireEvent.click(screen.getByText("Plus")); expect(input.value).toBe(String(maximum));
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.click(screen.getByText("Minus")); expect(input.value).toBe("1");
  });
});
