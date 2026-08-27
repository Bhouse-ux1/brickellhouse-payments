# BrickellHouse Payments

BrickellHouse Payments is the internal employee website used to prepare resident transactions and, in a later phase, send verified payment requests to the building's Stripe S710 terminal. The website is payment-management software; the S710 is the physical point-of-sale terminal.

The current repository is a local-only foundation. It does not create payments, control a reader, send receipts, or connect to any live service.

## Architecture

```text
Employee browser
  → Cloudflare Worker
    → React SPA and Hono API
      → Better Auth / Microsoft Entra ID (after configuration)
      → trusted transaction reconstruction
      → Drizzle ORM
      → Cloudflare Hyperdrive (after provisioning)
      → Neon PostgreSQL (after provisioning)
      → Stripe Terminal S710 boundary (disabled)
      → Resend receipt boundary (disabled)
```

- React 19, Vite 8, TypeScript, and React Router render the employee SPA.
- Cloudflare's official Vite plugin runs Worker code in the Workers runtime during development and preview.
- Hono owns `/api/*` routes in the same application.
- Drizzle defines the PostgreSQL schema and an unapplied migration.
- Production database construction reads `env.HYPERDRIVE.connectionString`; `DATABASE_URL` exists only for local Worker or Drizzle tooling.
- Better Auth is mounted on Hono using Web Standard requests. Microsoft Entra configuration remains disabled until credentials are supplied.
- Stripe Terminal and receipt delivery are interfaces with disabled implementations.

## Repository structure

```text
src/
  App.tsx                         employee SPA and client-side routes
  domain/                         framework-independent financial rules
  db/                             Drizzle schema, Worker database factory, seed tool
  services/                       transaction, terminal, and email boundaries
worker/
  index.ts                        Worker entry and route composition
  routes/                         small Hono route modules
  middleware/                     server-side employee authentication
  services/                       Worker-specific integration helpers
drizzle/                          generated, unapplied PostgreSQL migration
vite.config.ts                    React + official Cloudflare Vite plugin
wrangler.jsonc                    local Worker/static-asset configuration
```

## Local development

Requirements: a current Node.js release compatible with the pinned packages and npm.

```bash
npm install
npm run dev
```

Open the exact local URL printed by Vite. The normal route enforces the session boundary. For visual development only, append `?preview=1`; Vite removes that development-only bypass from production builds.

No database is needed to review the UI or run unit tests. Copy `.dev.vars.example` to `.dev.vars` only when testing local Worker bindings. Never commit `.dev.vars`.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run worker:build
npm run cf:typegen
npm run db:generate
```

`npm run build` produces the React assets and Worker bundle. `npm run worker:build` performs a Wrangler dry run and does not deploy. `npm run db:generate` writes migration SQL but never applies it.

## Trusted financial rules

The browser may provide only resident fields, product IDs, quantities, and intentional Custom Charge inputs. The Worker reloads trusted products and reconstructs names, prices, GL codes, line totals, subtotal, fee, and total.

- All money is integer cents.
- The authoritative fee is `round(subtotalCents * 29 / 1000) + 30`; a zero subtotal has a zero fee.
- Custom Charge requires a description and a positive integer-cent amount no greater than $100,000.00.
- Browser-provided price, GL, line total, fee, subtotal, and final total fields are stripped and ignored.
- Product and transaction-item database constraints independently preserve money and GL invariants.

### Fixed GL assignments

- `40090`: every product and service except Valet Parking.
- `40090`: every Custom Charge.
- `40033`: Valet Parking only.

There is no employee-facing GL selector or override. The mapping is enforced in server domain code, tests, catalog seeding, and PostgreSQL checks.

## Authentication and authorization

All employee data and mutations are protected by Worker middleware. Unauthenticated requests to products, transactions, details, accounting, and payment-attempt routes return `401`. Accounting requires Admin, Manager, or Accounting role.

Better Auth requires a database and `BETTER_AUTH_SECRET`. Microsoft Entra sign-in is added only when all three Microsoft values are present. Roles are `ADMIN`, `MANAGER`, `EMPLOYEE`, and `ACCOUNTING`; inactive users are rejected.

## Database and Hyperdrive

The schema includes users, sessions, accounts, verifications, products, transactions, immutable transaction items, payment attempts, Stripe events, terminal readers, email deliveries, and audit events. It uses foreign keys, unique identities, indexes, checks, and the PostgreSQL sequence behind `POS-######` transaction numbers.

No database or Hyperdrive resource exists yet. When infrastructure is approved:

1. Create Neon PostgreSQL in a suitable region.
2. Review and apply the generated migration to a non-production database.
3. Seed the trusted catalog using a local `DATABASE_URL` and `npm run db:seed`.
4. Create Cloudflare Hyperdrive for the Neon connection.
5. Add its binding as `HYPERDRIVE` in `wrangler.jsonc` and regenerate Worker types.
6. Store runtime secrets with Cloudflare Worker secrets, never in the frontend.

## Reader concurrency and idempotency

Reader ownership is durable PostgreSQL state. Reservation locks the configured terminal reader row with `FOR UPDATE`; the same attempt resumes, another unexpired attempt is rejected as busy, and an expired reservation can be acquired atomically. A future live implementation must reconcile Stripe and reader state before reusing any stale lock.

Payment attempt identity is stable: `brickellhouse:<transactionId>:attempt:<number>`. Unique constraints protect attempt ordinals, idempotency keys, Stripe references, reader operation IDs, webhook event IDs, and one receipt delivery per transaction.

## Stripe Terminal and receipts

`POST /api/transactions/:id/payment-attempts` exists but returns `501`. No Stripe SDK is bundled and no payment request is created.

`POST /api/webhooks/stripe` reads the raw body, verifies Stripe's timestamped HMAC signature with Web Crypto, and then deliberately returns `501`. Before it can acknowledge events it must durably deduplicate the event, verify mode/amount/currency/transaction relationships, reconcile the payment, release the reader, and enqueue exactly one receipt atomically.

The receipt gateway also remains disabled. A future verified-payment worker may use Resend after `email_deliveries` persistence and retry behavior are complete.

## API surface

- `GET /api/health` — runtime/configuration status; no secrets.
- `GET /api/session` — current authorized employee.
- `/api/auth/*` — Better Auth handler.
- `GET /api/products` — trusted active catalog; authenticated.
- `GET|POST /api/transactions` — history and trusted draft creation; authenticated.
- `GET /api/transactions/:id` — immutable transaction detail; authenticated.
- `POST /api/transactions/:id/payment-attempts` — reserved, disabled terminal boundary.
- `GET /api/accounting/summary` — verified-payment GL grouping; role-restricted.
- `POST /api/webhooks/stripe` — signed raw-body boundary; reconciliation disabled.

## External setup still required

Nothing below has been created or connected:

- Cloudflare account, Worker, custom domain, and Hyperdrive binding.
- Neon PostgreSQL project and reviewed migration.
- Microsoft Entra single-tenant application and callback URL.
- Stripe account/test-mode Terminal location, S710 reader, keys, and webhook endpoint.
- Resend account, verified sender domain, and API key.

Required future secret names are documented in `.dev.vars.example`. Do not add real values until each integration phase is explicitly approved.
