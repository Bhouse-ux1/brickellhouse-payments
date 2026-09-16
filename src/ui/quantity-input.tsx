import { useState } from "react";
import { parseQuantityInput } from "../domain/transactions/validation";

// Draft text belongs only to the field. Cart calculations always retain the last
// valid quantity, including while an employee deletes or replaces the text.
export function QuantityInput({ label, value, maximum, disabled, onValueChange }: {
  label: string; value: number; maximum: number; disabled: boolean;
  onValueChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<{ text: string; quantity: number } | null>(null);
  // A stepper or refreshed cart takes precedence over an older editing buffer.
  if (draft && (draft.quantity !== value || disabled)) setDraft(null);
  const text = draft?.quantity === value ? draft.text : String(value);
  const invalid = text !== "" && parseQuantityInput(text, maximum) === null;
  return <input aria-label={label} type="number" inputMode="numeric" min={1} max={maximum} step={1}
    value={text} disabled={disabled} aria-invalid={invalid || undefined} data-large-quantity={maximum > 99 || undefined}
    onFocus={() => setDraft({ text: String(value), quantity: value })}
    onChange={event => {
      const next = parseQuantityInput(event.target.value, maximum);
      setDraft({ text: event.target.value, quantity: next ?? value });
      if (next !== null) onValueChange(next);
    }}
    onBlur={() => setDraft(null)}
    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); setDraft(null); } }}/>
}
