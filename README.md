# BrickellHouse Payments

BrickellHouse Payments is the standalone employee payment website for the physical Stripe S710 at BrickellHouse. It runs as a React application and Hono API on Cloudflare Workers, uses Neon PostgreSQL through Hyperdrive, and uses Stripe Terminal's server-driven API.

## Current safety boundary

This build is **live-mode only**, but deployment does not initiate a payment. A real card charge can begin only after an authenticated employee manually presses the displayed `Charge $XX.XX` button.

- The Worker refuses Stripe initialization unless `STRIPE_LIVE_MODE_ONLY=true` and the approved restricted `STRIPE_SECRET_KEY` begins with `rk_live_`.
- Test keys and non-live Stripe objects are rejected.
- Reader and Location IDs come only from Worker configuration; the browser cannot choose them.
- The browser submits product IDs, quantities, resident details, and validated Custom Charge inputs only.
- PostgreSQL products and immutable transaction snapshots determine prices and GL codes.
- The authoritative fee is `round(subtotalCents * 29 / 1000) + 30`; zero subtotal has zero fee.
- Standard products and Custom Charge use GL `40090`; only Valet Parking uses `40033`.
- Stripe receives exactly the database-backed authoritative total in integer cents.
- One durable payment attempt maps to one PaymentIntent and stable Stripe idempotency keys.
- PostgreSQL reader locking prevents two BrickellHouse transactions from using the S710 simultaneously.
- A transaction becomes PAID only after server-side Stripe retrieval and exact identity, amount, USD, live-mode, transaction, reader, location, and success verification.
- Only safe card-present results may be stored: Stripe IDs, brand, last four, reader/location, and payment time.

## Temporary access gate

Microsoft Entra is disabled in the active application flow. The existing user/session/account tables remain for future production authentication.

The current login is a **temporary testing-only control**, not the final employee authentication system. It validates `TEST_ACCESS_PASSWORD` inside the Worker and issues an expiring, signed `Secure`, `HttpOnly`, `SameSite=Strict` cookie using `TEST_SESSION_SECRET`. Neither secret is present in browser code or repository configuration. Replace this gate with final employee authentication before regular production operation.

## Required Cloudflare configuration

Keep the existing `HYPERDRIVE` binding. Add these values with Cloudflare secret/configuration management; never commit real values:

```text
TEST_ACCESS_PASSWORD
TEST_SESSION_SECRET
STRIPE_SECRET_KEY
STRIPE_TERMINAL_READER_ID
STRIPE_TERMINAL_LOCATION_ID
STRIPE_TERMINAL_WEBHOOK_SECRET
STRIPE_LIVE_MODE_ONLY=true
```

`STRIPE_TERMINAL_READER_ID` must identify the real registered S710 and `STRIPE_TERMINAL_LOCATION_ID` must be that reader's actual live Stripe Location. Configure the Stripe webhook URL as:

```text
https://<worker-host>/api/webhooks/stripe
```

Subscribe it to `terminal.reader.action_succeeded`, `terminal.reader.action_failed`, `payment_intent.succeeded`, and `payment_intent.payment_failed`. `terminal.reader.action_updated` is also accepted.

## Payment and recovery flow

1. The employee passes the temporary access gate.
2. The Worker creates the trusted database transaction and one payment attempt.
3. The Worker creates or retrieves the same live card-present PaymentIntent.
4. The Worker validates the configured physical S710 and live Location, reserves it in PostgreSQL, and calls `process_payment_intent`.
5. Browser refresh restores the active database transaction; duplicate clicks resume rather than creating another PaymentIntent.
6. Signed Stripe webhooks are stored by event ID and reconciled idempotently.
7. Successful reconciliation marks the transaction PAID and creates one pending receipt-delivery record. No email is sent because Resend remains disabled.

If Stripe or reader state is uncertain after a timeout, the application retains the attempt and lock for reconciliation. It does not create a replacement PaymentIntent automatically.

## Local development and validation

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run worker:build
```

Copy `.dev.vars.example` to `.dev.vars` only for local Worker development. `.dev.vars`, `.env`, build output, and Wrangler state are ignored. `DATABASE_URL` is local migration administration only; production database access uses `env.HYPERDRIVE.connectionString`.

## Deferred work

- Replace the temporary access password with final employee authentication.
- Configure Resend and receipt delivery only in a separately approved phase.
- Complete the first live physical card charge only under explicit operator instruction and supervision.
