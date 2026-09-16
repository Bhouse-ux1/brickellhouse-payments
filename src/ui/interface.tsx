import type { ReactNode } from "react";
import { ArrowRight, CreditCard, LoaderCircle, ShieldCheck } from "lucide-react";

export function Brand({ className = "brand" }: { className?: string }) {
  return <div className={className}><span className="brandMonogram" aria-hidden="true">BH</span><div>BrickellHouse<small>Management</small></div></div>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="pageHeader"><div><h1>{title}</h1><p>{description}</p></div>{children && <div className="headerAction">{children}</div>}</header>;
}

export function AccessLayout({ children }: { children: ReactNode }) {
  return <div className="signInPage"><aside className="accessWelcome"><Brand/><div className="accessIntroduction"><span>BrickellHouse Payments</span><h2>At your service.</h2><p>A considered experience for every resident.</p></div><div className="architecturalLines" aria-hidden="true"><i/><i/><i/><i/></div><p className="accessLocation">BrickellHouse · Miami</p></aside><div className="accessFormArea">{children}<p className="accessFooter">For authorized BrickellHouse employees</p></div></div>;
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
