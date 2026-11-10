# Wagerflow

Distributed wagering processor. Game providers submit `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK` over HTTP and SQS. PostgreSQL is the source of truth. Duplicate, out-of-order, and concurrent delivery must not double-credit, double-debit, drop a committed event, or produce a negative balance.

## Stack

Bun 1.4, TypeScript 6 strict, NestJS 12, MikroORM 7, PostgreSQL 16, MiniStack on port 4566.

## Run locally

```bash
bun install
docker compose up -d postgres ministack
bun run migrate
bun run queues
bun run start
```

The API listens on `PORT` (default 3000). Copy `.env.example` if you need to override URLs.

## Tests

```bash
bun run typecheck
bun run test:unit
bun run test:integration   # real PostgreSQL and MiniStack
bun run test:concurrency
bun test
```

Every integration and concurrency test checks that each wallet balance equals its ledger fold.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/wallets` | `201`, or `409 DUPLICATE_WALLET` |
| GET | `/wallets/:walletId` | `404 NOT_FOUND` |
| GET | `/wallets/:walletId/ledger` | keyset cursor |
| POST | `/wallets/:walletId/reconciliation` | never rewrites balances |
| POST | `/wagering/transactions` | requires `Idempotency-Key` |
| GET | `/wagering/transactions/:transactionId` | |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| GET | `/health/live` | unauthenticated |
| GET | `/health/ready` | unauthenticated, PostgreSQL and SQS |
| GET | `/metrics` | unauthenticated Prometheus text |

SQS ingress is `wager-transactions.fifo`. HTTP does not enqueue that request. Integration events go to `integration-events.fifo`.

## Layout

`src/wagering` owns the rules. `src/persistence` implements `WageringStore`. `src/http` and `src/messaging` are the edges and the only modules that log or record metrics.
