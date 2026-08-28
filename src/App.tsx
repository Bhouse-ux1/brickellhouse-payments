import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import {
  BellRing, Building2, CarFront, CircleParking, CreditCard, Droplets, KeyRound,
  CalendarDays, Download, Landmark, Minus, Plus, ReceiptText, Search, ShieldCheck, Thermometer, Wind, Wrench, X,
} from "lucide-react";
import { calculateProcessingFee } from "@/domain/payments/processing-fee";
import { productCatalog, type TrustedProduct } from "@/domain/products/catalog";
import { parseMoneyInput } from "@/domain/transactions/validation";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
type CatalogProduct = Omit<TrustedProduct, "glCode">;
const previewCatalog: readonly CatalogProduct[] = import.meta.env.DEV
  ? productCatalog
  : [];
const icons: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  parking_fob: CircleParking, elevator_fob: Building2, mailbox_key_copy: KeyRound,
  unit_key_copy: KeyRound, smoke_detector_battery: BellRing, ac_filter_replacement: Wind,
  unclogged_service: Droplets, thermostat_check: Thermometer,
  smoke_alarm_replacement: BellRing, valet_parking: CarFront,
};

function Shell({ children, employeeName }: { children: ReactNode; employeeName: string }) {
  const initials = employeeName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <div className="shell">
    <aside className="rail">
      <div className="brand"><span>BH</span><div>BrickellHouse<small>Management</small></div></div>
      <nav aria-label="Primary">
        <NavLink to="/" end><CreditCard size={17}/><span>New Transaction</span></NavLink>
        <NavLink to="/transactions"><ReceiptText size={17}/><span>Transactions</span></NavLink>
        <NavLink to="/accounting"><Landmark size={17}/><span>Accounting</span></NavLink>
      </nav>
      <div className="employee"><span>{initials}</span><div>{employeeName}<small>Employee</small></div></div>
    </aside>
    <main className="page">{children}</main>
  </div>;
}

function NewTransaction() {
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
  const [activeTransactionId, setActiveTransactionId] = useState<string | null>(() => preview ? null : sessionStorage.getItem("bh_active_transaction"));
  const [hydratedTransactionId, setHydratedTransactionId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<readonly CatalogProduct[]>(() => preview ? previewCatalog : []);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">(() => preview ? "ready" : "loading");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [unit, setUnit] = useState("");
  const [email, setEmail] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [custom, setCustom] = useState<{ description: string; amountCents: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [charging, setCharging] = useState(false);

  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    void fetch("/api/products", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Catalog request failed");
      const data = await response.json() as { products: CatalogProduct[] };
      setCatalog(data.products);
      setCatalogState("ready");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setCatalogState("error");
    });
    return () => controller.abort();
  }, [preview]);

  useEffect(() => {
    if (preview || !activeTransactionId) return;
    let stopped = false;
    async function refreshPayment() {
      try {
        const response = await fetch(`/api/transactions/${activeTransactionId}`);
        if (!response.ok) return;
        const data = await response.json() as {
          transaction: { unitNumber: string; customerEmail: string };
          items: Array<{ productId: string | null; productNameSnapshot: string; unitPriceCentsSnapshot: number; quantity: number }>;
          payment: { status: string; displayStatus: string };
        };
        if (stopped) return;
        setNotice(data.payment.displayStatus);
        if (hydratedTransactionId !== activeTransactionId) {
          setUnit(data.transaction.unitNumber);
          setEmail(data.transaction.customerEmail);
          setQuantities(Object.fromEntries(data.items.filter((item) => item.productId).map((item) => [item.productId!, item.quantity])));
          const customItem = data.items.find((item) => !item.productId);
          setCustom(customItem ? { description: customItem.productNameSnapshot, amountCents: customItem.unitPriceCentsSnapshot * customItem.quantity } : null);
          setHydratedTransactionId(activeTransactionId);
        }
        if (["PAID", "CANCELED"].includes(data.payment.status)) {
          sessionStorage.removeItem("bh_active_transaction");
          setActiveTransactionId(null);
          setHydratedTransactionId(null);
          if (data.payment.status === "PAID") {
            setUnit("");
            setEmail("");
            setQuantities({});
            setCustom(null);
          }
        }
      } catch {
        if (!stopped) setNotice("Payment status is temporarily unavailable. Do not start another charge.");
      }
    }
    void refreshPayment();
    const timer = window.setInterval(() => void refreshPayment(), 2500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeTransactionId, hydratedTransactionId, preview]);

  const products = useMemo(() => catalog.filter((p) =>
    (category === "All" || p.category === category) && p.displayName.toLowerCase().includes(search.toLowerCase())), [catalog, category, search]);
  const subtotal = catalog.reduce((sum, p) => sum + p.priceCents * (quantities[p.id] ?? 0), custom?.amountCents ?? 0);
  const fee = calculateProcessingFee(subtotal);
  const total = subtotal + fee;
  const selected = catalog.filter((p) => quantities[p.id]);
  const amountCents = parseMoneyInput(amount);
  const canCharge = Boolean(unit.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && (selected.length || custom));

  function change(product: CatalogProduct, delta: number) {
    if (activeTransactionId) return;
    setNotice("");
    setQuantities((current) => {
      const next = product.quantityAllowed ? Math.max(0, (current[product.id] ?? 0) + delta) : delta > 0 ? 1 : 0;
      const copy = { ...current };
      if (next) copy[product.id] = next; else delete copy[product.id];
      return copy;
    });
  }

  async function prepareCharge() {
    if (!canCharge || charging) return;
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1") {
      setNotice("Terminal setup is not complete. No payment was created.");
      return;
    }
    setCharging(true);
    setNotice("Preparing the transaction…");
    try {
      let transactionId = activeTransactionId;
      if (!transactionId) {
        const response = await fetch("/api/transactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            unitNumber: unit.trim(),
            customerEmail: email.trim(),
            items: selected.map((product) => ({ productId: product.id, quantity: quantities[product.id] })),
            customCharges: custom ? [custom] : [],
          }),
        });
        if (response.status === 401) { setNotice("Your session has ended. Sign in and try again."); return; }
        if (!response.ok) { setNotice("This transaction could not be prepared. Please try again."); return; }
        const data = await response.json() as { transaction: { id: string } };
        transactionId = data.transaction.id;
        sessionStorage.setItem("bh_active_transaction", transactionId);
        setActiveTransactionId(transactionId);
      }
      const terminal = await fetch(`/api/transactions/${transactionId}/payment-attempts`, { method: "POST" });
      const terminalData = await terminal.json() as { displayStatus?: string; error?: string };
      setNotice(terminalData.displayStatus ?? terminalData.error ?? "Payment status is being checked. Do not start another charge.");
    } catch {
      setNotice("The service is temporarily unavailable. No payment request was sent.");
    } finally {
      setCharging(false);
    }
  }

  return <>
    <header className="pageHeader"><div><span>Payments</span><h1>New Transaction</h1><p>Prepare a resident payment for the front desk terminal.</p></div><span className="statusDot live">Physical S710 · Live mode</span></header>
    <div className="workspace">
      <section className="flow">
        <div className="residentStrip">
          <div className="step"><i>1</i><div><span>Resident</span><small>Who is being charged?</small></div></div>
          <label><span>Unit number</span><input value={unit} disabled={Boolean(activeTransactionId)} onChange={(e) => setUnit(e.target.value)} placeholder="2305" /></label>
          <label className="email"><span>Resident email</span><input value={email} disabled={Boolean(activeTransactionId)} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="resident@example.com" /></label>
        </div>
        <div className="sectionHead"><div><span>2 · Add charges</span><h2>Products & services</h2></div><label className="search"><Search size={15}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products"/></label></div>
        <div className="filters">{["All", "Access", "Keys", "Maintenance", "Valet"].map((c) => <button key={c} className={category === c ? "active" : ""} onClick={() => setCategory(c)}>{c}</button>)}</div>
        <div className="custom">
          <div className="customTitle"><Wrench size={18}/><div><span>Custom Charge</span><small>For an item not listed</small></div></div>
          <label><span>Description</span><input value={description} disabled={Boolean(activeTransactionId)} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the charge"/></label>
          <label className="amount"><span>Amount</span><div><i>$</i><input value={amount} disabled={Boolean(activeTransactionId)} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00"/></div></label>
          <button disabled={Boolean(activeTransactionId) || !amountCents || description.trim().length < 2} onClick={() => { if (amountCents) { setCustom({ description: description.trim(), amountCents }); setDescription(""); setAmount(""); } }}><Plus size={15}/>Add</button>
        </div>
        {catalogState === "loading" && <div className="notice" role="status">Loading the trusted product catalog…</div>}
        {catalogState === "error" && <div className="notice" role="alert">The product catalog is temporarily unavailable.</div>}
        <div className="products">{products.map((product) => { const Icon = icons[product.id] ?? Wrench; const qty = quantities[product.id] ?? 0; return <button key={product.id} disabled={Boolean(activeTransactionId)} className={qty ? "product selected" : "product"} onClick={() => change(product, 1)}>
          <span className="productIcon"><Icon size={20} strokeWidth={1.7}/></span><span className="productCopy"><small>{product.category}</small><strong>{product.displayName}</strong><b>{money.format(product.priceCents / 100)}</b></span><span className="addMark">{qty || <Plus size={14}/>}</span>
        </button>; })}</div>
      </section>
      <aside className="summary">
        <div className="summaryHead"><div><span>Draft</span><h2>Current Transaction</h2></div><span>{selected.length + (custom ? 1 : 0)} {selected.length + (custom ? 1 : 0) === 1 ? "charge" : "charges"}</span></div>
        {(unit || email) && <div className="residentMini"><Building2 size={16}/><div><strong>{unit ? `Unit ${unit}` : "Unit pending"}</strong><small>{email || "Email pending"}</small></div></div>}
        <div className={selected.length || custom ? "lines" : "lines empty"}>
          {!selected.length && !custom && <div className="emptyState"><ReceiptText size={23}/><strong>No charges yet</strong><span>Select a product or add a custom charge.</span></div>}
          {selected.map((p) => <div className="line" key={p.id}><div><strong>{p.displayName}</strong><b>{money.format(p.priceCents * quantities[p.id] / 100)}</b></div><div className="lineBottom"><span className="qty"><button disabled={Boolean(activeTransactionId)} onClick={() => change(p, -1)}><Minus size={12}/></button><i>{quantities[p.id]}</i><button disabled={Boolean(activeTransactionId) || !p.quantityAllowed} onClick={() => change(p, 1)}><Plus size={12}/></button></span><button className="remove" disabled={Boolean(activeTransactionId)} onClick={() => change(p, -99)}>Remove</button></div></div>)}
          {custom && <div className="line customLine"><div><span><small>Custom charge</small><strong>{custom.description}</strong></span><b>{money.format(custom.amountCents / 100)}</b></div><button className="remove" disabled={Boolean(activeTransactionId)} onClick={() => setCustom(null)}><X size={11}/>Remove</button></div>}
        </div>
        <div className="totals"><div><span>Subtotal</span><b>{money.format(subtotal / 100)}</b></div><div><span>Processing fee</span><b>{money.format(fee / 100)}</b></div><div className="grand"><span>Total</span><b>{money.format(total / 100)}</b></div></div>
        {notice && <div className="notice" role="status">{notice}</div>}
        <button className="charge" disabled={!canCharge || charging} onClick={prepareCharge}><CreditCard size={17}/>{charging ? "Preparing…" : total ? `Charge ${money.format(total / 100)}` : "Charge"}</button>
        {activeTransactionId && <button className="cancelPayment" disabled={charging} onClick={async () => {
          setCharging(true);
          try {
            const response = await fetch(`/api/transactions/${activeTransactionId}/payment-attempts/cancel`, { method: "POST" });
            const data = await response.json() as { displayStatus?: string; error?: string };
            setNotice(data.displayStatus ?? data.error ?? "Payment status is being checked.");
            if (response.ok) { sessionStorage.removeItem("bh_active_transaction"); setActiveTransactionId(null); }
          } finally { setCharging(false); }
        }}>Cancel terminal payment</button>}
        {!canCharge && <p className="hint">Enter resident details and add a charge to continue.</p>}
      </aside>
    </div>
  </>;
}

function TransactionsPage() {
  return <><header className="pageHeader"><div><span>Payments</span><h1>Transactions</h1><p>Find resident payments and review their current status.</p></div><button className="outlineAction" disabled><Download size={14}/>Export CSV</button></header>
    <div className="records"><div className="recordTools"><label className="recordSearch"><Search size={15}/><input placeholder="Search transaction, unit, or email"/></label><label><span>From</span><input type="date"/></label><label><span>To</span><input type="date"/></label></div>
      <div className="recordTable"><div className="recordHead"><span>Transaction</span><span>Date</span><span>Unit</span><span>Resident</span><span>Status</span><span>Total</span></div><div className="recordEmpty"><ReceiptText size={24}/><strong>No transactions yet</strong><p>Completed and in-progress payments will appear here.</p></div></div>
    </div></>;
}

function AccountingPage() {
  return <><header className="pageHeader"><div><span>Payments</span><h1>Accounting</h1><p>Review verified payment activity by accounting code.</p></div><button className="outlineAction" disabled><Download size={14}/>Export CSV</button></header>
    <div className="accountingPage"><div className="accountingIntro"><div><span>Current period</span><h2>Payment allocation</h2><p>Only successfully verified payments are included.</p></div><label><CalendarDays size={14}/><input type="month"/></label></div>
      <div className="glRows"><div className="glRow"><div><span>40090</span><p>Products, services, and Custom Charges</p></div><div><small>Transactions</small><b>0</b></div><strong>$0.00</strong></div><div className="glRow"><div><span>40033</span><p>Valet Parking only</p></div><div><small>Transactions</small><b>0</b></div><strong>$0.00</strong></div></div>
      <div className="accountingEmpty"><ShieldCheck size={20}/><div><strong>Trusted allocations</strong><p>Accounting codes are assigned automatically and cannot be changed during checkout.</p></div></div>
    </div></>;
}

function SignInPage() {
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  async function signIn() {
    setMessage("");
    setWorking(true);
    try {
      const response = await fetch("/api/test-access/login", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
      });
      if (!response.ok) { setMessage(response.status === 401 ? "The access password is incorrect." : "Temporary access is not configured."); return; }
      window.location.assign("/");
    } finally { setWorking(false); }
  }
  return <div className="signInPage"><form className="signInPanel" onSubmit={(event) => { event.preventDefault(); void signIn(); }}><div className="signInBrand"><span>BH</span><div>BrickellHouse<small>Management</small></div></div><span className="signInKicker">Temporary controlled access</span><h1>Payment testing access</h1><p>This temporary gate protects the live payment interface until final employee authentication is implemented.</p><label className="accessPassword"><span>Access password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label><button type="submit" disabled={!password || working}>{working ? "Checking…" : "Continue"}</button>{message && <div role="status">{message}</div>}</form></div>;
}

function Application({ employeeName }: { employeeName: string }) {
  return <Shell employeeName={employeeName}><Routes><Route path="/" element={<NewTransaction/>}/><Route path="/transactions" element={<TransactionsPage/>}/><Route path="/accounting" element={<AccountingPage/>}/><Route path="*" element={<NewTransaction/>}/></Routes></Shell>;
}

export function App() {
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
  const [session, setSession] = useState<{ state: "checking" | "signed-out" | "signed-in"; name?: string }>(() => preview ? { state: "signed-in", name: "Alex Morgan" } : { state: "checking" });
  useEffect(() => {
    if (preview) return;
    void fetch("/api/session").then(async (response) => {
      if (!response.ok) { setSession({ state: "signed-out" }); return; }
      const data = await response.json() as { employee: { name: string } };
      setSession({ state: "signed-in", name: data.employee.name });
    }).catch(() => setSession({ state: "signed-out" }));
  }, [preview]);
  if (session.state === "checking") return <div className="sessionLoading">Opening BrickellHouse Payments…</div>;
  if (session.state === "signed-out") return <SignInPage/>;
  return <Application employeeName={session.name ?? "Employee"}/>;
}
