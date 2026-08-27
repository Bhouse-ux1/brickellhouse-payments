# BrickellHouse Payments — Session Resume

Last updated: August 27, 2026

## Safety and scope

- Repository: `brickellhouse-pos`, a standalone repository with no commits.
- Final architecture: React + Vite SPA, official Cloudflare Vite plugin, Cloudflare Worker, Hono API, Drizzle, Neon PostgreSQL through Cloudflare Hyperdrive, Better Auth, future Microsoft Entra ID, future server-driven Stripe Terminal S710, and future Resend receipts.
- The website is called BrickellHouse Management / Payments. The S710 is the physical point-of-sale terminal; do not call the website a POS in employee-facing UI.
- Do not deploy, commit, push, create remote resources, apply migrations, configure live services, create a payment, contact a resident, or send a receipt without explicit authorization.
- No live external action has occurred.

## Rebuild completed locally

- The Next.js application, App Router, route handlers, middleware-oriented auth files, Next configuration, generated `.next` output, and runtime packages were removed.
- `vite.config.ts` combines React with `@cloudflare/vite-plugin`.
- `wrangler.jsonc` routes `/api/*` through `worker/index.ts` and serves the SPA for navigation fallbacks.
- Hono route modules cover health, session/auth, products, transactions, details, payment-attempt reservation, accounting, and Stripe webhook boundaries.
- Worker secrets and bindings are read from `c.env`; application state is not stored in memory.
- Production PostgreSQL construction expects `HYPERDRIVE.connectionString`. No Hyperdrive or Neon resource has been created.

## Employee experience

- Cream, parchment, warm-gray, muted-charcoal, restrained-green visual system.
- Compact navigation and readable, low-weight typography.
- Cohesive New Transaction workspace with compact resident information.
- Clickable product tiles with selected quantities, filtering, and search.
- First-class Custom Charge description/amount entry.
- Sticky Current Transaction with charges, subtotal, automatic fee, total, and dynamic `Charge $…` action.
- Natural terminal status language; no employee-facing implementation identifiers.
- Transactions and Accounting foundations use the same visual system.
- Normal local and production navigation requires a session. `?preview=1` works only under Vite development for visual review.

## Nonnegotiable accounting rules

- Every normal product except Valet Parking → GL `40090`.
- Every Custom Charge → GL `40090`.
- Valet Parking only → GL `40033`.
- Employees cannot view, select, enter, edit, or override GL values during checkout.
- Server reconstruction ignores forged browser GL values and also ignores a forged GL stored on a supplied product object.
- PostgreSQL checks repeat the fixed mapping for products and immutable transaction items.

## Trusted transaction behavior

- Browser input: unit, resident email, product ID, quantity, Custom Charge description, Custom Charge base amount.
- Worker-owned output: product name, product price, GL, line totals, subtotal, processing fee, total.
- Fee: `round(subtotalCents * 29 / 1000) + 30`; zero subtotal → zero fee.
- Custom Charge: required 2–160 character description, positive integer cents, maximum $100,000.00.
- Draft persistence uses a PostgreSQL transaction and concurrency-safe `POS-######` sequence.

## Database model

The unapplied migration defines users, sessions, accounts, verifications, products, transactions, immutable transaction items, payment attempts, Stripe events, terminal readers, email deliveries, and audit events. Money is integer cents. Unique constraints protect transaction numbers, attempt identities, Stripe references, event IDs, and one receipt per transaction.

## Authentication

- Better Auth is created inside the Worker only when PostgreSQL and `BETTER_AUTH_SECRET` exist.
- The raw Web Standard handler is mounted at `/api/auth/*`.
- Microsoft Entra provider configuration activates only when client ID, secret, and tenant ID all exist.
- Protected Hono middleware rejects missing/inactive/unknown-role employees.
- Roles: ADMIN, MANAGER, EMPLOYEE, ACCOUNTING. Accounting endpoint requires Admin, Manager, or Accounting.

## Terminal, locking, and webhooks

- Terminal gateway remains disabled and returns no Stripe identifiers.
- Logical attempt key: `brickellhouse:<transactionId>:attempt:<n>`.
- Reader reservation uses PostgreSQL `FOR UPDATE`, durable lock fields, same-attempt resume, busy rejection, and stale-lock acquisition.
- A future live flow must reconcile Stripe before reusing a stale reservation.
- Stripe webhook reads the raw body and verifies timestamped HMAC signatures with Web Crypto.
- Even a valid signature receives `501` until durable event deduplication and full reconciliation are implemented.
- Receipt gateway remains disabled; no email can be sent.

## Commands to run after changes

```text
npm run typecheck
npm run lint
npm test
npm run build
npm run worker:build
npm run cf:typegen       # after wrangler bindings change
npm run db:generate      # after schema changes; inspect SQL, do not migrate
```

## External setup order

1. Create Cloudflare and Neon resources only after approval.
2. Review/apply the migration to a non-production Neon database and seed products.
3. Create Hyperdrive and add the `HYPERDRIVE` binding.
4. Register Microsoft Entra single-tenant auth and set the final callback/origin.
5. Test authenticated transaction creation and history without Stripe.
6. Implement test-mode webhook persistence/reconciliation with database tests.
7. Implement payment-attempt persistence and simulated reader flow.
8. Configure Stripe test-mode location and S710 only in a separately approved phase.
9. Add verified receipt queueing and Resend only after payment reconciliation is proven.

## Read first next time

1. `README.md`
2. `SESSION_RESUME.md`
3. `worker/index.ts`
4. `worker/auth.ts`
5. `src/db/schema.ts`
6. `src/domain/transactions/reconstruct.ts`
7. `src/domain/accounting/gl-rules.ts`
8. `src/services/terminal/reader-reservation.ts`
9. `worker/routes/webhooks.ts`
