# BrickellHouse Payments — Session Resume

Last updated: August 28, 2026

Read `README.md` first. The standalone repository is connected to `Bhouse-ux1/brickellhouse-payments`; Neon is initialized and production database access uses the configured Cloudflare Hyperdrive binding.

Current application boundaries:

- Microsoft Entra and Better Auth are removed from the active flow. Existing auth-related database tables remain for future final employee authentication.
- A temporary testing-only access password is validated inside the Worker and represented by a signed, expiring HttpOnly cookie.
- Stripe Terminal is implemented with the server-driven REST API for the configured real physical S710.
- Stripe is live-mode only and fails closed unless the explicit live-only flag, live secret, Reader ID, Location ID, and webhook secret are configured.
- Deploying or loading the application never starts a payment. Only a manual authenticated `Charge $XX.XX` action can create or resume the stable PaymentIntent and send it to the configured reader.
- Trusted prices, GL rules, Custom Charge validation, processing fee, and total remain server-authoritative.
- PostgreSQL owns transaction attempts, PaymentIntent identity, reader locking, webhook deduplication, reconciliation, PAID state, and pending receipt records.
- Resend and actual email delivery remain disabled.

Before the first live card charge, configure the exact secrets and Stripe identifiers documented in `README.md`, verify the webhook subscriptions, confirm the S710 is online at the configured live Location, and obtain explicit operator authorization.
