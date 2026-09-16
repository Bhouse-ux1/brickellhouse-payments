# BrickellHouse Payments

BrickellHouse Payments is the standalone employee payment website for the physical Stripe S710 at BrickellHouse. React and Hono run on Cloudflare Workers, Supabase PostgreSQL is reached through Hyperdrive, Stripe Terminal uses the server-driven API, Better Auth provides employee access, and Resend delivers authentication messages and verified-payment receipts.

## Production safety boundary

Deployment and page loads never initiate a payment. A live card charge begins only when an authenticated employee manually presses `Process Payment` after `Show Breakdown`. Displaying the breakdown alone never initiates a charge.

- The Worker accepts only the approved live restricted Stripe key format and rejects test-mode objects.
- Reader and Location IDs are server configuration; the browser cannot choose them.
- PostgreSQL products and immutable transaction snapshots determine prices, GL codes, and totals in integer cents.
- The authoritative fee is `round(subtotalCents * 29 / 1000) + 30`; a zero subtotal has no fee.
- Standard products and Custom Charge use GL `40090`; only Valet Parking uses `40033`.
- Stable idempotency keys, PostgreSQL reader locking, signed-webhook deduplication, exact amount reconciliation, and refresh recovery remain authoritative.
- A transaction becomes PAID only after independent live Stripe retrieval and exact identity, amount, USD, reader, location, and success checks.

## Employee authentication

Authentication is self-hosted Better Auth using the existing Supabase/Drizzle user, account, session, and verification tables. Supabase Auth is not used because it is not a drop-in replacement for this existing Better Auth schema and would introduce a second authentication system without the custom server controls required here.

- Email and password only; public signup is disabled.
- Accounts must be created by an Admin. Roles are `ADMIN` and `STAFF`.
- New accounts receive a one-hour password-setup link and remain unverified until password setup completes.
- Passwords are salted one-way hashes managed by Better Auth; plaintext passwords are never stored.
- Sessions use `Secure`, `HttpOnly`, `SameSite=Strict` cookies in production and expire after 30 minutes of inactivity. Session refresh does not alter Stripe or PostgreSQL payment reconciliation state.
- Sign-in is limited to five attempts per five minutes using the PostgreSQL `rate_limits` table, so enforcement is shared across Worker isolates.
- Products, transactions, terminal actions, and receipt resend require an active verified employee. Accounting and staff administration require Admin.
- Login, logout, password-reset, email-delivery, and employee-administration events are stored in `audit_events` without passwords or credentials.

The temporary `TEST_ACCESS_PASSWORD` / `TEST_SESSION_SECRET` code and Cloudflare bindings are removed. Archived temporary identities remain only when required for immutable historical transaction attribution; they are inactive, banned, non-privileged, and ineligible for password reset.

### First Admin bootstrap

Keep the values below only in the ignored local `.env`; never commit them:

```text
DATABASE_URL=<Supabase owner connection used only for bootstrap>
BETTER_AUTH_SECRET=<at least 32 random bytes; same value as the Worker secret>
BETTER_AUTH_URL=https://brickellhouse-payments.assistantmanager.workers.dev
RESEND_API_KEY=<server-side Resend key>
EMAIL_FROM=<verified sender address, for example payments@a-verified-domain.example>
INITIAL_ADMIN_EMAIL=<approved BrickellHouse administrator>
```

After the sender is verified and Worker secrets are configured, run once:

```bash
npm run auth:bootstrap-admin
```

The command is idempotent: it creates or safely recovers the configured Admin, ensures exactly one Better Auth `local:credential` account with a random inaccessible bootstrap password, preserves completed passwords, and requests a fresh one-hour setup link only while the Admin remains unverified. Resend acceptance and the production setup origin are mandatory.

## Verified-payment receipts

Successful Stripe reconciliation atomically marks the trusted transaction PAID and inserts one `RESIDENT_RECEIPT` delivery row. Only that PAID row can be delivered. Webhook retries, browser refreshes, and Worker retries cannot create a second base delivery because `(transaction_id, kind)` is unique; Resend also receives the stable idempotency key `receipt/<transaction-id>/v<delivery-version>`.

The responsive receipt renders only trusted stored snapshots: transaction reference and payment time, item name, quantity, unit and line amounts, processing fee, exact total, and optional card brand/last four. It excludes GL codes and all Stripe, webhook, reader, and database IDs. Email failure never changes PAID status. An authenticated employee can retry a failed receipt or explicitly resend a sent receipt; an intentional resend increments the delivery version.

Receipt/authentication email delivery requires the `RESEND_API_KEY` Worker secret and the committed `EMAIL_FROM` sender variable:

```text
RESEND_API_KEY
EMAIL_FROM
```

`EMAIL_FROM` must be a single verified sender email address on a Resend-verified domain. The browser never receives either value. No implementation test sends a real email.

## Cloudflare configuration

Committed non-secret configuration includes `STRIPE_LIVE_MODE_ONLY=true`, `BETTER_AUTH_URL`, `EMAIL_FROM`, and the existing `HYPERDRIVE` binding. Configure these secrets with `wrangler secret put`; do not commit values:

```text
BETTER_AUTH_SECRET
RESEND_API_KEY
STRIPE_SECRET_KEY
STRIPE_TERMINAL_READER_ID
STRIPE_TERMINAL_LOCATION_ID
STRIPE_TERMINAL_WEBHOOK_SECRET
```

The Stripe webhook remains `/api/webhooks/stripe` with the existing live event subscriptions. No Stripe credential, endpoint, S710 setting, Hyperdrive configuration, or payment data is changed by the authentication/receipt phase.

## Local validation

### Setup and cancellation recovery

The employee flow is **Show Breakdown -> Process Payment -> success**. Show Breakdown sends the trusted itemized cart with `set_reader_display` and persists a `BREAKDOWN_READY` stage only after Stripe acknowledges the matching display. It creates no PaymentIntent. The UI then says “Resident may review the breakdown and present their card.” Process Payment is immediately available without a card-presented signal or employee confirmation.

This explicitly follows [Stripe Terminal pre-dip behavior](https://docs.stripe.com/terminal/features/display) for the US S710. A card may be presented before or after Process Payment; Stripe handles a pre-presented card internally, without an app event or a second collection call. Process Payment verifies the displayed total against the independently reconstructed trusted total and creates/resumes one PaymentIntent with that exact amount. It submits at most one Reader process command per attempt. Card presentation timing never creates another PaymentIntent or triggers a replay. Existing pricing, fee, GL, minimum, strict success reconciliation, durable observations and idempotent receipt delivery remain enforced.

The transaction's trusted cart is frozen once shown. Repeated Show Breakdown and polling preserve it; a matching trusted Stripe display update does not reset the logical attempt. The application does not clear, replace or automatically expire a breakdown during review, including after the reservation TTL. Only explicit Cancel can discard the cart and any invisible pre-dip. Before processing, Cancel verifies that intent creation has not begun, clears only the owned cart and atomically abandons the transaction/releases its reservation. After processing begins, the existing strict Stripe/Reader/observation checks apply; unknown authorization or intent-creation outcomes remain protected.

Persisted stage claims fence setup, processing and Cancel against each other. Polling cannot overwrite newer attempt state with stale `READER_RESERVED`, and delayed responses preserve PROCESSING, PAID and canceled states. Browser requests time out after 30 seconds without erasing the active transaction. A stalled setup/processing request shows recovery guidance after two minutes; a successfully displayed breakdown has no review timeout.

The Admin-only GET `/api/admin/diagnostics/terminal-incident` is retained for non-charging production verification of POS-000026 and the configured S710. It uses read-only SQL and Stripe GETs and returns only allowlisted status fields and counts, with caching disabled. It never returns secrets, raw Stripe objects or card details. The one-time `/recover` form and POST were removed after successful recovery.

The test suite includes in-memory PostgreSQL migrations and deterministic interleavings, plus a local mocked DOM for cart-reset and Cancel behavior. These tests do not access a browser, production Stripe, Supabase or Resend.

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npx wrangler deploy --dry-run
```

`.env`, `.dev.vars`, `dist`, Wrangler state, and local build output are ignored. Production database access uses `env.HYPERDRIVE.connectionString`; the Supabase session-pooler owner URL is for local migration/bootstrap only.
