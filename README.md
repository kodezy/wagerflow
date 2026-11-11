# Wagerflow

Distributed wagering processor. Game providers submit `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK` over HTTP and SQS.

PostgreSQL is the source of truth. Duplicate, out-of-order, or concurrent delivery must not double-credit, double-debit, drop a committed event, or produce a negative balance.

## Stack

- Bun 1.4
- TypeScript 6 (strict)
- NestJS 12
- MikroORM 7
- PostgreSQL 16
- MiniStack (port 4566)

## Run locally

```bash
bun install
docker compose up -d postgres ministack
bun run migrate
bun run queues
bun run start
```

API on `PORT` (default 3000). Copy `.env.example` to override URLs.

## Tests

Quick check:

```bash
bun run typecheck
bun run test:unit
```

Full suite (PostgreSQL + MiniStack):

```bash
bun run test
```

`bun run test` runs unit, integration, and concurrency with a 120s timeout. For one slice: `bun run test:integration` or `bun run test:concurrency`. Plain `bun test` keeps the 5s default.

Integration and concurrency tests check wallet balance against the ledger.

Optional load test (not in `bun run test`):

```bash
bun run test:load
```

**CI (push to GitHub)**

- `unit` — Typecheck + unit tests
- `proof` — Compose `postgres` + `ministack`, then integration + concurrency

## API

| Method | Path | Description |
| --- | --- | --- |
| POST | `/wallets` | Create wallet; optional initial balance |
| GET | `/wallets/:walletId` | Balance and metadata |
| GET | `/wallets/:walletId/ledger` | Ledger; opaque `cursor` and `limit` |
| POST | `/wallets/:walletId/reconciliation` | Stored balance vs ledger (read-only) |
| POST | `/wagering/transactions` | Submit wager; needs `Idempotency-Key` |
| GET | `/wagering/transactions/:transactionId` | Outcome by internal id |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Outcome by provider and external id |
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | PostgreSQL and SQS reachable |
| GET | `/metrics` | Prometheus |

Submit over HTTP or `wager-transactions.fifo`. After commit, events go to `integration-events.fifo`. Permanent SQS failures go to `wager-transactions-dlq.fifo`.

`404 NOT_FOUND` when the wallet or wager does not exist. `409 DUPLICATE_WALLET` when the same `playerId` and currency already have a wallet. Health and metrics are unauthenticated.

Status codes and bodies: [ARCHITECTURE.md](ARCHITECTURE.md#http).

## Architecture

```
src/
  wagering/            Wager rules; HTTP and SQS share one submit path
  persistence/         MikroORM `WageringStore` and migrations
  http/                REST, idempotency header, provider guard
  messaging/           Wager consumer, outbox publisher, pending-reference worker
  main.ts              Process entrypoint
  app.ts               Nest wiring; HTTP plus queue workers in one process
  config.ts            Database, queues, and port from environment
  observability.ts     Prometheus registry; JSON lines to stdout
```

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — Design, idempotency, errors, messaging
- [docs/CHALLENGE.md](docs/CHALLENGE.md) — Original requirements
- [docs/LOAD.md](docs/LOAD.md) — Optional load test
