# BrickellHouse Payments

BrickellHouse Payments is the standalone employee payment website for the physical Stripe S710 at BrickellHouse. React and Hono run on Cloudflare Workers, Neon PostgreSQL is reached through Hyperdrive, Stripe Terminal uses the server-driven API, Better Auth provides employee access, and Resend delivers authentication messages and verified-payment receipts.

## Production safety boundary

Deployment and page loads never initiate a payment. A live card charge begins only when an authenticated employee manually presses `Charge $XX.XX`.

- The Worker accepts only the approved live restricted Stripe key format and rejects test-mode objects.
- Reader and Location IDs are server configuration; the browser cannot choose them.
- PostgreSQL products and immutable transaction snapshots determine prices, GL codes, and totals in integer cents.
- The authoritative fee is `round(subtotalCents * 29 / 1000) + 30`; a zero subtotal has no fee.
- Standard products and Custom Charge use GL `40090`; only Valet Parking uses `40033`.
- Stable idempotency keys, PostgreSQL reader locking, signed-webhook deduplication, exact amount reconciliation, and refresh recovery remain authoritative.
- A transaction becomes PAID only after independent live Stripe retrieval and exact identity, amount, USD, reader, location, and success checks.

## Employee authentication

Authentication is self-hosted Better Auth using the existing Neon/Drizzle user, account, session, and verification tables. Managed Neon Auth was not selected because it is not a drop-in replacement for this existing Better Auth schema and would introduce a second authentication system without the custom server controls required here.

- Email and password only; public signup is disabled.
- Accounts must be created by an Admin. Roles are `ADMIN` and `STAFF`.
- New accounts receive a one-hour password-setup link and remain unverified until password setup completes.
- Passwords are salted one-way hashes managed by Better Auth; plaintext passwords are never stored.
- Sessions use `Secure`, `HttpOnly`, `SameSite=Strict` cookies in production and expire after 30 minutes of inactivity. Session refresh does not alter Stripe or PostgreSQL payment reconciliation state.
- Sign-in is limited to five attempts per five minutes using the PostgreSQL `rate_limits` table, so enforcement is shared across Worker isolates.
- Products, transactions, terminal actions, and receipt resend require an active verified employee. Accounting and staff administration require Admin.
- Login, logout, password-reset, email-delivery, and employee-administration events are stored in `audit_events` without passwords or credentials.

The temporary `TEST_ACCESS_PASSWORD` / `TEST_SESSION_SECRET` code and bindings are removed. Those two Cloudflare secrets can be deleted only after this production authentication build is deployed and the first Admin login is verified.

### First Admin bootstrap

Keep the values below only in the ignored local `.env`; never commit them:

```text
DATABASE_URL=<direct neondb_owner connection used only for migration/bootstrap>
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

Receipt/authentication email delivery requires these Worker secrets:

```text
RESEND_API_KEY
EMAIL_FROM
```

`EMAIL_FROM` must be a single verified sender email address on a Resend-verified domain. The browser never receives either value. No implementation test sends a real email.

## Cloudflare configuration

Committed non-secret configuration includes `STRIPE_LIVE_MODE_ONLY=true`, `BETTER_AUTH_URL`, and the existing `HYPERDRIVE` binding. Configure these with `wrangler secret put`; do not commit values:

```text
BETTER_AUTH_SECRET
RESEND_API_KEY
EMAIL_FROM
STRIPE_SECRET_KEY
STRIPE_TERMINAL_READER_ID
STRIPE_TERMINAL_LOCATION_ID
STRIPE_TERMINAL_WEBHOOK_SECRET
```

The Stripe webhook remains `/api/webhooks/stripe` with the existing live event subscriptions. No Stripe credential, endpoint, S710 setting, Hyperdrive configuration, or payment data is changed by the authentication/receipt phase.

## Local validation

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npx wrangler deploy --dry-run
```

`.env`, `.dev.vars`, `dist`, Wrangler state, and local build output are ignored. Production database access uses `env.HYPERDRIVE.connectionString`; the direct owner URL is for local migration/bootstrap only.
