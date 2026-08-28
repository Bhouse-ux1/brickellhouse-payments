# BrickellHouse Payments — Session Resume

Last updated: August 28, 2026

Read `README.md` first. This is the standalone `Bhouse-ux1/brickellhouse-payments` repository.

- The live Stripe S710 server-driven flow and all existing payment safety controls remain unchanged.
- Self-hosted Better Auth on Neon replaces the temporary shared-password gate in the pending build. Public signup is disabled; Admin creates Admin/Staff accounts.
- Production sessions are secure HttpOnly cookies with a 30-minute inactivity timeout. PostgreSQL provides distributed sign-in rate limiting and audit logs.
- The additive auth/receipt migration is applied. It did not change transaction, item, attempt, Stripe event, product, or session counts.
- Resend sends authentication messages and receipts only when `RESEND_API_KEY` and a verified `EMAIL_FROM` are configured.
- A receipt is queued only by independently reconciled PAID state and uses both database uniqueness and a versioned Resend idempotency key.
- The partial initial Admin was recovered against Better Auth 1.7.2's issuer-scoped account schema. One unverified Admin, one inaccessible bootstrap credential, and one one-hour setup token exist; Resend accepted the setup email from `BrickellHouse Management <orders@brickellhouse.org>`.
- Production deployment must wait until the administrator personally completes the emailed password setup. Do not replace the working production gate before that verification.
- Never initiate a payment, command the S710, or send a real receipt as a configuration test.
