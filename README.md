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
bun run test:load          # optional; Docker, three processes, writes wagerflow_load unless LOAD_DATABASE_URL is set
```

Every integration and concurrency test checks that each wallet balance equals its ledger fold. Load testing is outside `bun test`; see `docs/LOAD.md`.

## API

| Method | Path | Description |
|---|---|---|
| POST | `/wallets` | Open a wallet with an optional initial balance |
| GET | `/wallets/:walletId` | Wallet balance and metadata |
| GET | `/wallets/:walletId/ledger` | Ledger entries; opaque `cursor` and `limit` |
| POST | `/wallets/:walletId/reconciliation` | Compare stored balance to the ledger fold (read-only) |
| POST | `/wagering/transactions` | Submit a wager operation; requires `Idempotency-Key` |
| GET | `/wagering/transactions/:transactionId` | Wager outcome by internal transaction id |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Wager outcome by provider and external id |
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | Readiness: PostgreSQL and SQS |
| GET | `/metrics` | Prometheus text exposition |

HTTP wager submit runs in-process. Producers may also send work on SQS (`wager-transactions.fifo`). Committed integration events publish to `integration-events.fifo`. Unknown wallet or wager returns `404 NOT_FOUND`. `POST /wallets` returns `409 DUPLICATE_WALLET` for the same `playerId` and currency. Health and metrics routes are unauthenticated.

## Layout

`src/wagering` owns the rules. `src/persistence` implements `WageringStore`. `src/http` and `src/messaging` are the edges and the only modules that log or record metrics.
