# AGENTS.md

## Purpose

Wagerflow is a distributed wagering processor: game providers submit round operations (`BET` → `WIN` | `LOSS` | `REFUND` | `ROLLBACK`) over HTTP and SQS. Correctness under duplicate, out-of-order, and concurrent delivery is the product, not CRUD.

Repository map for coding agents. Keep this file concise. Architectural decisions live in `ARCHITECTURE.md`.

## Repository map

- Challenge requirements: `docs/CHALLENGE.md`
- Architecture and trade-offs: `ARCHITECTURE.md`

## Stack

- Runtime / package manager / tests: Bun 1.x
- Language: TypeScript strict
- HTTP: NestJS
- Persistence: PostgreSQL, versioned reversible migrations
- ORM: MikroORM
- Messaging: AWS SQS via MiniStack (`ministackorg/ministack`, port 4566)
- Local orchestration: Docker Compose

## Commands

Bootstrap:
`bun install && docker compose up -d postgres ministack && bun run migrate && bun run queues`

Fast validation:
`bun run typecheck && bun run test:unit`

Full test suite:
`bun run test`

Load test (optional):
`bun run test:load` when present

## Core invariants

- Money is never `number`, `float`, or `double`. Amounts enter and leave the system as decimal strings with scale 2. Domain `Money` is immutable and independent of ORM types.
- Idempotency is persistent. In-memory caches are not a correctness guarantee. The same key with a different payload is a conflict, not a replay. The same provider transaction id with a different key is also a conflict. Replay returns the stored result of the current status. A terminal result does not change.
- Uniqueness, ledger immutability, and non-negative balance are enforced in the database schema, not only in application code. Ledger entries are never overwritten or deleted.
- Inbox, wallet, ledger, and outbox rows that a path actually writes share the one SQL transaction that stores the wager. Events are not published before that commit.
- The concurrency unit is `walletId`. No global lock across wallets. Balance is never `read → calculate → update` without concurrency control. Correctness holds with multiple application instances.
- PostgreSQL holds committed balances and outcomes. SQS FIFO ordering and broker deduplication are optimizations.
- `OPENING` is internal only. `LOSS`, `REJECTED`, and `FAILED` do not move balance and do not write ledger. `REFUND` / `ROLLBACK` require the same provider, player, wallet, currency, and round, and reverse at most once at an equal amount.
- Terminal transaction statuses (`PROCESSED`, `REJECTED`, `FAILED`) do not transition further.
- Health endpoints are unauthenticated. Queue messages are an internal channel. `providerId` in the payload is a wager field. Submit checks `playerId` against the wallet and `providerId` against the reference together with player, wallet, currency, and round. The auth guard is a separate port.

## Context routing

When changing money, wallet, ledger, transaction lifecycle, HTTP, messaging, locking, auth, schema, or logging:
read `ARCHITECTURE.md`. Core invariants in this file are the short form.

When `ARCHITECTURE.md` does not settle a contract:
read `docs/CHALLENGE.md`.

When the task needs current facts about coding-agent products or harness behavior:
use $coding-agent-landscape (in-session research; do not add research dumps to this file).

Do not read all documentation before every task.

## Definition of done

- Wallet materialized balance equals the balance reconstructed from the ledger.
- Required unit, integration (real PostgreSQL and SQS), and concurrency tests covering the change pass when those commands exist.
- Duplicate, out-of-order, and multi-instance cases cannot duplicate credits or debits, drop committed events, or produce a negative balance.
- Docs updated if contracts or invariants changed.

## Local instructions

Follow the coding agent host's documented instruction precedence; user chat in the session wins.
User-facing product copy may be Portuguese; code, APIs, identifiers, and this file stay in English.
