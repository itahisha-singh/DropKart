# DropKart

A limited-drop checkout service for high-demand releases (for example, sneaker drops or concert tickets). It demonstrates inventory correctness under concurrency, idempotent checkout, payment lifecycle handling, integer-only money arithmetic, a double-entry ledger, signed provider webhooks, and reconciliation.

**Current status: Phase 2 — checkout + mock payments + ledger + safe-money.** This is an independent learning/portfolio prototype. It is not affiliated with, endorsed by, or connected to PayPal or any payment provider. The payment provider is simulated; never use real card details or real money.

## What it demonstrates

| Engineering problem | Approach | Implementation |
|---|---|---|
| Buyers race for the last item | Atomic `UPDATE ... WHERE stock >= quantity`, plus database constraints | `services/checkoutService.ts` |
| Retries create duplicate orders/payments | Idempotency key stored in the same transaction as business changes | `services/idempotency.ts` |
| Reservation hoarding | One active order per user/product; timed holds and `FOR UPDATE SKIP LOCKED` expiry sweeper | `db/schema.sql` |
| Payment provider outcomes | Local mock provider can approve, decline, or simulate an ambiguous timeout | `services/mockPaymentProvider.ts` |
| Forged/replayed webhooks | HMAC-SHA256 signatures and unique provider event IDs | `services/paymentService.ts` |
| Money rounding errors | Integer minor units, checked arithmetic, currency decimal metadata, fair splits | `src/money/safeMoney.ts` |
| Ledger drift | Balanced debit/credit journals and reconciliation discrepancy records | `ledger_entries`, `reconciliation_*` |

## Checkout and payment lifecycle

`RESERVED → PAYMENT_PENDING → PAID`

Other outcomes include `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`, and `REFUNDED`. A failed attempt can be retried while the reservation remains valid. A provider timeout is treated as an ambiguous result: the order remains pending rather than assuming success or failure. The mock timeout itself does not charge.

## Technology

- Node.js 22+, TypeScript, Express
- PostgreSQL 14+
- Zod request validation
- Vitest and Supertest
- Docker Compose for local PostgreSQL and app startup

## Run locally

Prerequisites: Node.js 22+ and Docker Desktop (or a local PostgreSQL 14+ instance).

```bash
cp .env.example .env
npm install
docker compose up -d db
npm run dev
```

The API listens on `http://localhost:3000`. The default tokens in `.env.example` are for local development only. Set unique values for `ADMIN_TOKEN` and `WEBHOOK_SECRET` before exposing the service anywhere. The prototype has no end-user authentication; `userId` is supplied in the request body and must not be treated as a production identity.

To build and type-check:

```bash
npm run typecheck
npm run build
```

## API

All amounts are integer minor units (for example, INR 125.50 is `12550`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/products` | Create a product; requires `x-admin-token` |
| `GET` | `/products/:id` | Read product and remaining stock |
| `POST` | `/orders` | Reserve inventory; requires `Idempotency-Key` |
| `GET` | `/orders/:id` | Read order state |
| `POST` | `/orders/:id/pay` | Run mock payment; requires `Idempotency-Key`; optional body `{ "outcome": "APPROVED" \| "DECLINED" \| "TIMEOUT" }` |
| `POST` | `/orders/:id/cancel` | Cancel an unpaid reservation; requires `Idempotency-Key` |
| `POST` | `/orders/:id/refund` | Simulate refund of a paid order; requires `Idempotency-Key` |
| `POST` | `/webhooks/mock-provider` | Receive a signed mock-provider event; requires `x-provider-signature` |
| `POST` | `/admin/reconciliation/run` | Run ledger reconciliation; requires `x-admin-token` |

### Example flow

Create a product:

```bash
curl -X POST http://localhost:3000/products \
  -H 'content-type: application/json' -H 'x-admin-token: dev-admin-token' \
  -d '{"name":"DropKart Sneaker","priceMinor":49900,"currency":"INR","stock":25,"maxPerOrder":2}'
```

Reserve an order (replace the product ID):

```bash
curl -X POST http://localhost:3000/orders \
  -H 'content-type: application/json' -H 'Idempotency-Key: reserve-demo-0001' \
  -d '{"productId":"PRODUCT_UUID","userId":"demo-user","quantity":1}'
```

Pay using the simulator:

```bash
curl -X POST http://localhost:3000/orders/ORDER_UUID/pay \
  -H 'content-type: application/json' -H 'Idempotency-Key: pay-demo-0001' \
  -d '{"outcome":"APPROVED"}'
```

Use `DECLINED` to exercise a failed payment, or `TIMEOUT` to exercise an ambiguous provider timeout. Each distinct attempt needs a new idempotency key.

## Money module

`src/money/safeMoney.ts` contains reusable integer-minor-unit helpers:

- checked multiplication for line totals;
- currency decimal metadata (INR/USD/EUR/GBP: 2; JPY: 0);
- fair splitting where remainder minor units are assigned deterministically;
- basis-point percentage calculations using `BigInt` intermediates and half-up rounding.

No floating-point arithmetic is used for monetary calculations. This module is currently part of this repository; it has not been published as a separate npm package.

## Double-entry ledger and reconciliation

A successful payment writes a balanced journal:

- Debit `PROVIDER_CLEARING` for the payment amount.
- Credit `MERCHANDISE_REVENUE` for the same amount.

A simulated refund writes the reversing journal. Each journal is balanced by construction. The reconciliation endpoint checks paid/refunded orders for missing or unbalanced ledger totals and records discrepancies in `reconciliation_discrepancies`.

## Tests

The tests use PostgreSQL because mocks cannot demonstrate transaction isolation, row locking, or race behavior. Configure `TEST_DATABASE_URL` to point to a disposable test database named `dropkart_test`, then run:

```bash
npm test
```

The suite includes the Phase 1 race/idempotency/lifecycle tests plus Phase 2 payment approval, decline/retry, timeout, refund, ledger balancing, reconciliation, and safe-money arithmetic tests. Do not run tests against a database containing data you need: test setup truncates project tables.

## Known limitations

- The payment provider is a deterministic local simulator, not a real gateway. Refunds are simulated ledger reversals.
- The prototype has no user authentication or authorization model; request `userId` is not trusted identity.
- The admin token is a simple shared development token, not production admin authentication.
- No distributed tracing, metrics dashboard, rate limiting, or waiting room yet (planned Phase 3/4 work).
- A `TIMEOUT` simulation does not create a real external charge. In a real integration, an ambiguous provider result must be resolved by querying the provider or processing its later webhook before retrying a charge.
- This project is not production-ready and must not process real payments or real payment-card data.

## Project structure

```text
src/app.ts                         Express routes and validation
src/services/checkoutService.ts    inventory reservations and order lifecycle
src/services/paymentService.ts     payment events, ledger, refunds, reconciliation
src/services/mockPaymentProvider.ts signed local payment simulator
src/services/idempotency.ts         idempotent request execution
src/money/safeMoney.ts              integer-based currency helpers
db/schema.sql                       PostgreSQL schema and Phase 2 tables
tests/                              API, lifecycle, concurrency, payment and money tests
scripts/loadtest.ts                 concurrency/load simulation
```

## Author

**Itahisha Singh** — Computer Science and Engineering student.
