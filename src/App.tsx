import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import {
  BellRing, Building2, CarFront, CircleParking, CreditCard, Droplets, KeyRound,
  CalendarDays, Download, Landmark, LogOut, Minus, Plus, Printer, ReceiptText, Search, ShieldCheck, Thermometer, UserCog, Wind, Wrench, X,
} from "lucide-react";
import { calculateProcessingFee } from "@/domain/payments/processing-fee";
import { productCatalog, type TrustedProduct } from "@/domain/products/catalog";
import { MAX_QUANTITY, parseMoneyInput, parseQuantityInput } from "@/domain/transactions/validation";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
type EmployeeRole = "ADMIN" | "STAFF";

async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status === 401) window.dispatchEvent(new Event("bh-auth-expired"));
  return response;
}
type CatalogProduct = Omit<TrustedProduct, "glCode">;
const previewCatalog: readonly CatalogProduct[] = import.meta.env.DEV
  ? productCatalog
  : [];
const icons: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  parking_fob: CircleParking, elevator_fob: Building2, mailbox_key_copy: KeyRound,
  unit_key_copy: KeyRound, smoke_detector_battery: BellRing, ac_filter_replacement: Wind,
  unclogged_service: Droplets, thermostat_check: Thermometer,
  smoke_alarm_replacement: BellRing, black_white_printing: Printer,
  color_printing: Printer, valet_parking: CarFront,
};

function Shell({ children, employeeName, employeeRole, onSignOut }: { children: ReactNode; employeeName: string; employeeRole: EmployeeRole; onSignOut: () => void }) {
  const initials = employeeName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <div className="shell">
    <aside className="rail">
      <div className="brand"><span>BH</span><div>BrickellHouse<small>Management</small></div></div>
      <nav aria-label="Primary">
        <NavLink to="/" end><CreditCard size={17}/><span>New Transaction</span></NavLink>
        <NavLink to="/transactions"><ReceiptText size={17}/><span>Transactions</span></NavLink>
        {employeeRole === "ADMIN" && <NavLink to="/accounting"><Landmark size={17}/><span>Accounting</span></NavLink>}
        {employeeRole === "ADMIN" && <NavLink to="/admin"><UserCog size={17}/><span>Staff Access</span></NavLink>}
      </nav>
      <div className="employee"><span>{initials}</span><div>{employeeName}<small>{employeeRole === "ADMIN" ? "Administrator" : "Staff"}</small></div><button aria-label="Sign out" title="Sign out" onClick={onSignOut}><LogOut size={15}/></button></div>
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
  const [readerDisplayPending, setReaderDisplayPending] = useState(false);

  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    void authenticatedFetch("/api/products", { signal: controller.signal }).then(async (response) => {
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
        const response = await authenticatedFetch(`/api/transactions/${activeTransactionId}`);
        if (!response.ok) return;
        const data = await response.json() as {
          transaction: { unitNumber: string; customerEmail: string };
          items: Array<{ productId: string | null; productNameSnapshot: string; unitPriceCentsSnapshot: number; quantity: number }>;
          payment: { status: string; displayStatus: string; readerDisplayPending: boolean };
        };
        if (stopped) return;
        setNotice(data.payment.displayStatus);
        setReaderDisplayPending(data.payment.readerDisplayPending);
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
          setReaderDisplayPending(false);
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
      const next = product.quantityAllowed ? Math.min(MAX_QUANTITY, Math.max(0, (current[product.id] ?? 0) + delta)) : delta > 0 ? 1 : 0;
      const copy = { ...current };
      if (next) copy[product.id] = next; else delete copy[product.id];
      return copy;
    });
  }

  function setQuantity(product: CatalogProduct, value: string) {
    if (activeTransactionId || !product.quantityAllowed) return;
    const next = parseQuantityInput(value);
    if (!next) return;
    setNotice("");
    setQuantities((current) => ({ ...current, [product.id]: next }));
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
        const response = await authenticatedFetch("/api/transactions", {
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
      const terminal = await authenticatedFetch(`/api/transactions/${transactionId}/payment-attempts`, { method: "POST" });
      const terminalData = await terminal.json() as { displayStatus?: string; error?: string; readerDisplayPending?: boolean };
      if (typeof terminalData.readerDisplayPending === "boolean") setReaderDisplayPending(terminalData.readerDisplayPending);
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
        <div className="filters">{["All", "Access", "Keys", "Maintenance", "Printing", "Valet"].map((c) => <button key={c} className={category === c ? "active" : ""} onClick={() => setCategory(c)}>{c}</button>)}</div>
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
          {selected.map((p) => <div className="line" key={p.id}><div><strong>{p.displayName}</strong><b>{money.format(p.priceCents * quantities[p.id] / 100)}</b></div><div className="lineBottom"><span className="qty"><button aria-label={`Decrease ${p.displayName} quantity`} disabled={Boolean(activeTransactionId)} onClick={() => change(p, -1)}><Minus size={12}/></button><input aria-label={`${p.displayName} quantity`} disabled={Boolean(activeTransactionId) || !p.quantityAllowed} inputMode="numeric" min={1} max={MAX_QUANTITY} step={1} type="number" value={quantities[p.id]} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setQuantity(p, event.target.value)}/><button aria-label={`Increase ${p.displayName} quantity`} disabled={Boolean(activeTransactionId) || !p.quantityAllowed || quantities[p.id] >= MAX_QUANTITY} onClick={() => change(p, 1)}><Plus size={12}/></button></span><button className="remove" disabled={Boolean(activeTransactionId)} onClick={() => change(p, -MAX_QUANTITY)}>Remove</button></div></div>)}
          {custom && <div className="line customLine"><div><span><small>Custom charge</small><strong>{custom.description}</strong></span><b>{money.format(custom.amountCents / 100)}</b></div><button className="remove" disabled={Boolean(activeTransactionId)} onClick={() => setCustom(null)}><X size={11}/>Remove</button></div>}
        </div>
        <div className="totals"><div><span>Subtotal</span><b>{money.format(subtotal / 100)}</b></div><div><span>Processing fee</span><b>{money.format(fee / 100)}</b></div><div className="grand"><span>Total</span><b>{money.format(total / 100)}</b></div></div>
        {notice && <div className="notice" role="status">{notice}</div>}
        <button className="charge" disabled={!canCharge || charging} onClick={prepareCharge}><CreditCard size={17}/>{charging ? "Preparing…" : readerDisplayPending ? "Start card payment" : total ? `Review ${money.format(total / 100)} on S710` : "Review on S710"}</button>
        {activeTransactionId && <button className="cancelPayment" disabled={charging} onClick={async () => {
          setCharging(true);
          try {
            const action = readerDisplayPending ? "clear-terminal" : "cancel";
            const response = await authenticatedFetch(`/api/transactions/${activeTransactionId}/payment-attempts/${action}`, { method: "POST" });
            const data = await response.json() as { displayStatus?: string; error?: string };
            setNotice(data.displayStatus ?? data.error ?? "Payment status is being checked.");
            if (response.ok) { sessionStorage.removeItem("bh_active_transaction"); setActiveTransactionId(null); setReaderDisplayPending(false); }
          } finally { setCharging(false); }
        }}>{readerDisplayPending ? "Clear Terminal" : "Cancel terminal payment"}</button>}
        {!canCharge && <p className="hint">Enter resident details and add a charge to continue.</p>}
      </aside>
    </div>
  </>;
}

function TransactionsPage() {
  type HistoryRow = {
    id: string; number: string; unitNumber: string; customerEmail: string; totalCents: number;
    paymentStatus: string; createdAt: string; lastErrorCode: string | null; receiptStatus: string | null;
  };
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [receiptMessage, setReceiptMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void authenticatedFetch("/api/transactions", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("History request failed");
      const data = await response.json() as { transactions: HistoryRow[] };
      setRows(data.transactions);
      setHistoryState("ready");
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHistoryState("error");
    });
    return () => controller.abort();
  }, []);
  const visibleRows = rows.filter((row) => [row.number, row.unitNumber, row.customerEmail]
    .some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));
  const completedCount = rows.filter((row) => row.paymentStatus === "PAID").length;
  function historyStatus(row: HistoryRow) {
    if (row.paymentStatus === "PAID") return "Completed payment";
    if (row.paymentStatus === "FAILED") return "Failed attempt";
    if (row.paymentStatus === "CANCELED" && ["employee_abandoned", "display_timeout", "reader_display_abandoned"].includes(row.lastErrorCode ?? "")) return "Abandoned attempt";
    if (row.paymentStatus === "CANCELED") return "Canceled attempt";
    return "In progress";
  }
  return <><header className="pageHeader"><div><span>Payments</span><h1>Transactions</h1><p>Find resident payments and review their current status.</p></div><button className="outlineAction" disabled><Download size={14}/>Export CSV</button></header>
    <div className="records"><div className="recordTools"><label className="recordSearch"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transaction, unit, or email"/></label><label><span>From</span><input type="date" disabled/></label><label><span>To</span><input type="date" disabled/></label></div>
      {receiptMessage && <div className="historyNote" role="status">{receiptMessage}</div>}
      {historyState === "ready" && completedCount === 0 && rows.length > 0 && <div className="historyNote">No completed payments yet. Canceled, abandoned, failed, and in-progress attempts are listed below.</div>}
      <div className="recordTable"><div className="recordHead"><span>Transaction</span><span>Date</span><span>Unit</span><span>Resident</span><span>Status</span><span>Total</span></div>
        {historyState === "loading" && <div className="recordEmpty"><ReceiptText size={24}/><strong>Loading payment activity…</strong></div>}
        {historyState === "error" && <div className="recordEmpty"><ReceiptText size={24}/><strong>Payment activity is unavailable</strong><p>Please refresh to try again.</p></div>}
        {historyState === "ready" && rows.length === 0 && <div className="recordEmpty"><ReceiptText size={24}/><strong>No payment activity yet</strong><p>Completed payments and attempts will appear here.</p></div>}
        {historyState === "ready" && rows.length > 0 && visibleRows.length === 0 && <div className="recordEmpty"><Search size={24}/><strong>No matching payment activity</strong><p>Try a different transaction, unit, or email.</p></div>}
        {historyState === "ready" && visibleRows.map((row) => { const label = historyStatus(row); return <div className="recordRow" key={row.id}><strong>{row.number}</strong><span>{new Date(row.createdAt).toLocaleString()}</span><span>{row.unitNumber}</span><span>{row.customerEmail}</span><span className="historyStateCell"><i className={`historyStatus ${label.toLowerCase().replaceAll(" ", "-")}`}>{label}</i>{row.paymentStatus === "PAID" && <button onClick={async () => { setReceiptMessage("Sending receipt…"); const response = await authenticatedFetch(`/api/transactions/${row.id}/receipt/resend`, { method: "POST" }); setReceiptMessage(response.ok ? "Receipt sent." : "Receipt could not be sent. Verify email configuration and try again."); }}>{row.receiptStatus === "SENT" ? "Resend receipt" : "Send receipt"}</button>}</span><b>{money.format(row.totalCents / 100)}</b></div>; })}
      </div>
    </div></>;
}

function AccountingPage() {
  return <><header className="pageHeader"><div><span>Payments</span><h1>Accounting</h1><p>Review verified payment activity by accounting code.</p></div><button className="outlineAction" disabled><Download size={14}/>Export CSV</button></header>
    <div className="accountingPage"><div className="accountingIntro"><div><span>Current period</span><h2>Payment allocation</h2><p>Only successfully verified payments are included.</p></div><label><CalendarDays size={14}/><input type="month"/></label></div>
      <div className="glRows"><div className="glRow"><div><span>40090</span><p>Products, services, and Custom Charges</p></div><div><small>Transactions</small><b>0</b></div><strong>$0.00</strong></div><div className="glRow"><div><span>40033</span><p>Valet Parking only</p></div><div><small>Transactions</small><b>0</b></div><strong>$0.00</strong></div></div>
      <div className="accountingEmpty"><ShieldCheck size={20}/><div><strong>Trusted allocations</strong><p>Accounting codes are assigned automatically and cannot be changed during checkout.</p></div></div>
    </div></>;
}

function AdminPage() {
  type Employee = { id: string; name: string; email: string; role: EmployeeRole; active: boolean; emailVerified: boolean };
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<EmployeeRole>("STAFF");
  const [message, setMessage] = useState("");
  async function loadEmployees() {
    const response = await authenticatedFetch("/api/admin/users");
    if (!response.ok) { setMessage("Staff access is unavailable."); return; }
    const data = await response.json() as { users: Employee[] };
    setEmployees(data.users);
  }
  useEffect(() => {
    const controller = new AbortController();
    void authenticatedFetch("/api/admin/users", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Staff access request failed");
      const data = await response.json() as { users: Employee[] };
      setEmployees(data.users);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Staff access is unavailable.");
    });
    return () => controller.abort();
  }, []);
  async function createEmployee() {
    setMessage("Creating employee access…");
    const response = await authenticatedFetch("/api/admin/users", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, role }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) { setMessage(body.error ?? "Employee access could not be created."); return; }
    setName(""); setEmail(""); setRole("STAFF"); setMessage("Employee created. A secure password setup email was sent.");
    await loadEmployees();
  }
  return <><header className="pageHeader"><div><span>Administration</span><h1>Staff Access</h1><p>Create and manage approved BrickellHouse employee accounts.</p></div></header><div className="adminPage">
    <section className="adminCreate"><h2>Add employee</h2><p>No public registration is available. The employee receives a secure password setup link.</p><div><label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as EmployeeRole)}><option value="STAFF">Staff</option><option value="ADMIN">Admin</option></select></label><button disabled={name.trim().length < 2 || !email.includes("@")} onClick={() => void createEmployee()}>Create access</button></div>{message && <div className="historyNote" role="status">{message}</div>}</section>
    <section className="adminUsers"><h2>Approved employees</h2>{employees.map((employee) => <div className="adminUser" key={employee.id}><div><strong>{employee.name}</strong><span>{employee.email}</span><small>{employee.emailVerified ? "Email verified" : "Password setup pending"}</small></div><select value={employee.role} onChange={async (event) => { await authenticatedFetch(`/api/admin/users/${employee.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: employee.active, role: event.target.value }) }); await loadEmployees(); }}><option value="STAFF">Staff</option><option value="ADMIN">Admin</option></select><button onClick={async () => { await authenticatedFetch(`/api/admin/users/${employee.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: !employee.active, role: employee.role }) }); await loadEmployees(); }}>{employee.active ? "Disable" : "Enable"}</button>{!employee.emailVerified && <button onClick={async () => { const response = await authenticatedFetch(`/api/admin/users/${employee.id}/send-password-setup`, { method: "POST" }); setMessage(response.ok ? "Password setup email sent." : "Password setup email could not be sent."); }}>Send setup</button>}</div>)}</section>
  </div></>;
}

function SignInPage() {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [forgot, setForgot] = useState(false);
  async function signIn() {
    setMessage("");
    setWorking(true);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), password, rememberMe: false }),
      });
      if (!response.ok) { setMessage(response.status === 429 ? "Too many sign-in attempts. Please wait and try again." : "Email or password is incorrect, or this account is not active."); return; }
      window.location.assign("/");
    } finally { setWorking(false); }
  }
  async function requestReset() {
    setWorking(true);
    await fetch("/api/auth/request-password-reset", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), redirectTo: `${window.location.origin}/reset-password` }),
    });
    setWorking(false); setMessage("If this approved employee account exists, a password reset link has been sent.");
  }
  return <div className="signInPage"><form className="signInPanel" onSubmit={(event) => { event.preventDefault(); void (forgot ? requestReset() : signIn()); }}><div className="signInBrand"><span>BH</span><div>BrickellHouse<small>Management</small></div></div><span className="signInKicker">Internal payment management</span><h1>{forgot ? "Reset password" : "Sign in"}</h1><p>{forgot ? "Enter your approved employee email to receive a secure reset link." : "Use your approved BrickellHouse employee account."}</p><label className="accessPassword"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus /></label>{!forgot && <label className="accessPassword"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}<button type="submit" disabled={!email || (!forgot && !password) || working}>{working ? "Please wait…" : forgot ? "Send reset link" : "Sign In"}</button><button className="forgotButton" type="button" onClick={() => { setForgot(!forgot); setMessage(""); }}>{forgot ? "Back to Sign In" : "Forgot Password"}</button>{message && <div role="status">{message}</div>}</form></div>;
}

function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get("token");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(token ? "" : "This password reset link is invalid or expired.");
  const [working, setWorking] = useState(false);
  return <div className="signInPage"><form className="signInPanel" onSubmit={async (event) => { event.preventDefault(); if (!token) return; setWorking(true); const response = await fetch("/api/auth/reset-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newPassword: password, token }) }); setWorking(false); setMessage(response.ok ? "Password set. You can now sign in." : "This password reset link is invalid or expired."); }}><div className="signInBrand"><span>BH</span><div>BrickellHouse<small>Management</small></div></div><span className="signInKicker">Secure employee access</span><h1>Set password</h1><p>Choose at least 12 characters. All existing sessions are revoked when a password is reset.</p><label className="accessPassword"><span>New password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label><button type="submit" disabled={!token || password.length < 12 || working}>{working ? "Saving…" : "Set password"}</button><button className="forgotButton" type="button" onClick={() => window.location.assign("/")}>Back to Sign In</button>{message && <div role="status">{message}</div>}</form></div>;
}

function Application({ employeeName, employeeRole, onSignOut }: { employeeName: string; employeeRole: EmployeeRole; onSignOut: () => void }) {
  return <Shell employeeName={employeeName} employeeRole={employeeRole} onSignOut={onSignOut}><Routes><Route path="/" element={<NewTransaction/>}/><Route path="/transactions" element={<TransactionsPage/>}/>{employeeRole === "ADMIN" && <Route path="/accounting" element={<AccountingPage/>}/>} {employeeRole === "ADMIN" && <Route path="/admin" element={<AdminPage/>}/>}<Route path="*" element={<NewTransaction/>}/></Routes></Shell>;
}

export function App() {
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
  const [session, setSession] = useState<{ state: "checking" | "signed-out" | "signed-in"; name?: string; role?: EmployeeRole }>(() => preview ? { state: "signed-in", name: "Alex Morgan", role: "ADMIN" } : { state: "checking" });
  useEffect(() => {
    if (preview) return;
    const expired = () => setSession({ state: "signed-out" });
    window.addEventListener("bh-auth-expired", expired);
    void fetch("/api/session").then(async (response) => {
      if (!response.ok) { setSession({ state: "signed-out" }); return; }
      const data = await response.json() as { employee: { name: string; role: EmployeeRole } };
      setSession({ state: "signed-in", name: data.employee.name, role: data.employee.role });
    }).catch(() => setSession({ state: "signed-out" }));
    return () => window.removeEventListener("bh-auth-expired", expired);
  }, [preview]);
  if (window.location.pathname === "/reset-password") return <ResetPasswordPage/>;
  if (session.state === "checking") return <div className="sessionLoading">Opening BrickellHouse Payments…</div>;
  if (session.state === "signed-out") return <SignInPage/>;
  return <Application employeeName={session.name ?? "Employee"} employeeRole={session.role ?? "STAFF"} onSignOut={async () => { await fetch("/api/auth/sign-out", { method: "POST" }); setSession({ state: "signed-out" }); }}/>;
}
