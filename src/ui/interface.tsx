import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CreditCard, LoaderCircle, Minus, Plus, ShieldCheck } from "lucide-react";
import { QuantityInput } from "./quantity-input";

export function Brand({ className = "brand" }: { className?: string }) {
  return <div className={className}><span className="brandMonogram" aria-hidden="true">BH</span><div>BrickellHouse<small>Management</small></div></div>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="pageHeader"><div><h1>{title}</h1><p>{description}</p></div>{children && <div className="headerAction">{children}</div>}</header>;
}

export function AccessLayout({ children }: { children: ReactNode }) {
  return <div className="signInPage"><header className="accessHeader"><Brand/></header><main className="accessFormArea">{children}</main></div>;
}

// This quantity stages an Add interaction only; the existing cart handler still
// enforces the trusted product's quantity rules and calculates every total.
export function ProductCard({ name, category, price, icon, selectedQuantity, quantityAllowed, maximumQuantity, disabled, onAdd }: {
  name: string; category: string; price: string; icon: ReactNode; selectedQuantity: number;
  quantityAllowed: boolean; maximumQuantity: number; disabled: boolean; onAdd: (quantity: number) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  return <article className={`product${selectedQuantity ? " selected" : ""}`} data-disabled={disabled || undefined}>
    <div className="productVisual" aria-hidden="true">{icon}{selectedQuantity > 0 && <span className="addMark" key={selectedQuantity}>{selectedQuantity} in cart</span>}</div>
    <div className="productCopy"><h3>{name}</h3><p>{category}</p><strong>{price}</strong></div>
    <div className="productActions"><span className="qty" role="group" aria-label={`Quantity to add for ${name}`}>
      <button aria-label="Decrease quantity to add" disabled={disabled || !quantityAllowed || quantity <= 1} onClick={() => setQuantity(current => Math.max(1, current - 1))}><Minus size={13}/></button>
      <QuantityInput label={`Quantity to add for ${name}`} value={quantity} maximum={maximumQuantity} disabled={disabled || !quantityAllowed} onValueChange={setQuantity}/>
      <button aria-label="Increase quantity to add" disabled={disabled || !quantityAllowed || quantity >= maximumQuantity} onClick={() => setQuantity(current => Math.min(maximumQuantity, current + 1))}><Plus size={13}/></button>
    </span><button className="addProduct" disabled={disabled} aria-label={`Add ${name}`} onClick={() => onAdd(quantity)}>Add</button></div>
  </article>;
}

// Announce completed cancellation to assistive technology without leaving an old
// payment banner in the newly empty cart. The announcement also expires.
export function ClearedPaymentAnnouncement() {
  const [finished, setFinished] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setFinished(true), 3000); return () => window.clearTimeout(timer); }, []);
  return finished ? null : <span className="srOnly" role="status">Payment canceled.</span>;
}

type PaymentActionProps = {
  label: string;
  disabled: boolean;
  busy: boolean;
  minimumBlocked: boolean;
  success: boolean;
  recovery: boolean;
  onClick: () => void;
};

// Presentation only. The caller retains every existing payment guard and action.
// The wrapper receives hover; the native button remains disabled throughout.
export function PaymentAction({ label, disabled, busy, minimumBlocked, success, recovery, onClick }: PaymentActionProps) {
  const Icon = busy ? LoaderCircle : success ? ShieldCheck : CreditCard;
  return <div className="paymentAction" data-minimum-blocked={minimumBlocked || undefined} data-state={busy ? "loading" : success ? "success" : recovery ? "recovery" : disabled ? "disabled" : "ready"}>
    <button className="charge" disabled={disabled} aria-busy={busy} aria-describedby={minimumBlocked ? "minimum-payment-guidance" : undefined} onClick={onClick}>
      <Icon size={19} className={busy ? "loadingIcon" : undefined} aria-hidden="true"/><span>{label}</span>{!disabled && <ArrowRight size={18} className="actionArrow" aria-hidden="true"/>}
    </button>
  </div>;
}
