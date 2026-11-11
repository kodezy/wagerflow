# Load experiment

Optional. `bun run test:load` is not part of `bun run test` and has no RPS target. Setup failures exit non-zero. After the workload, the script exits non-zero only when a money or outbox check fails.

## Setup

```bash
docker compose up -d postgres ministack
bun run test:load
```

The client starts three processes (`bun src/main.ts`) on ports 3411–3413. Each process serves HTTP and runs the consumer, the outbox publisher, and the pending-reference worker. PostgreSQL is `wagerflow_load` on the Compose Postgres (created if missing). SQS queues use a fresh `load<run>-` prefix on MiniStack, so this does not publish into the default local queues. Override the database with `LOAD_DATABASE_URL`. Rows stay in that database. The prefixed queues stay in MiniStack until that emulator is reset.

Stop anything already bound to 3411–3413. The generator and the three servers share one machine.

## Method

One run, four HTTP phases, client concurrency in flight:

| Phase | What is sent |
|---|---|
| spread | 240 unique `BET`s of `1.00` across 16 wallets opened at `5000.00`, concurrency 16 |
| hot-wallet | 80 unique `BET`s of `1.00` on one wallet opened at `5000.00`, concurrency 8 |
| replay | 49 identical submits of one `10.00` bet on a wallet opened at `100.00`, concurrency 16 |
| tight-balance | 12 unique `BET`s of `80.00` on a wallet opened at `100.00`, concurrency 12 |

Phases run one after another. The `sequential` row is their sum, not mixed load. Replay is the same key; it is not the debit path.

Latency is the client round trip in ms. p50/p95/p99 use nearest rank. Error rate is transport failures plus HTTP 5xx, including 503 from the 2s wallet `lock_timeout`. The table column `fail` is transport failures and HTTP 5xx other than 503. `leftovers` is pending, HTTP 4xx, and unclassified bodies. `REJECTED` is a business result. A replay is `idempotentReplay` on HTTP 200.

Outbox while sending is the age of the oldest unpublished row for this run, sampled every 250ms until the client stops. Drain then waits up to 30s for publishers to send rows that already committed. The Prometheus gauge is read once, 700ms later, so it can show the publisher's next tick. That gauge is database-wide; the SQL sample is not.

Expected outbox count for a clean run: 19 openings and 322 processed bets each enqueue `WagerTransactionProcessed` and `WalletBalanceChanged`; 11 rejections enqueue only `WagerTransactionRejected`. That is 693 rows.

Checked before exit: stored balance equals the ledger fold; stored balance equals the opening minus processed bet debits; debits do not exceed the amounts sent; the replay wallet has one processed bet; the tight wallet has one processed bet and balance `20.00`; this run's outbox reaches zero unpublished rows.

## What this size shows

On this host the hot wallet did not reach `lock_timeout`. Eighty bets at concurrency 8 finished in under a second, so `wagerflow_lock_conflicts_total` stayed 0. The contention that did show up is the tight wallet: one debit, eleven `REJECTED`. The stable bottleneck was the publisher. While the client was sending, unpublished age stayed under 1s; at stop hundreds of committed rows were still unpublished, and three publishers then took about 5.8s to drain them. Sequential client throughput moves between runs on the same machine. Quote the drain and the invariants, not the RPS, as the result.

SQS ingress is not driven. The consumer is up and idle.

## Recorded run

2026-11-11, darwin 25.3.0, 10 CPUs, 16 GiB, Bun 1.4.4. Postgres 16 and MiniStack from `docker compose`, both published on localhost. Exit 0.

```text
phase            conc    n    sec    rps    p50    p95    p99  processed  replay  rejected  503  fail  409
spread             16  240   0.49  485.2     30     59     79        240       0         0    0     0    0
hot-wallet          8   80   0.44  180.1     40     69     79         80       0         0    0     0    0
replay             16   49   0.11  434.5     31     39     40          1      48         0    0     0    0
tight-balance      12   12   0.09  134.9     54     89     89          1       0        11    0     0    0
sequential          0  381   1.14  334.0     32     66     83        322      48        11    0     0    0

errors: 0/381 (0.0%)
concurrency: http 503 0, lock_conflicts metric 0, business rejected 11
idempotency replays: 48; payload conflicts (409): 0
leftovers: pending 0, http 4xx 0, unclassified 0
outbox while sending: peak unpublished age 0.962s; at client stop 573 unpublished, oldest 1.015s
outbox after commit: publishers drained already-committed rows in 5782ms to 0 unpublished / 693 published
metrics after the next publisher tick: outbox gauge 0.000s, retries 0, dlq depth 0

invariants: pass (ledger fold, debits within attempts, one replay debit, one tight-wallet debit, outbox drained)
```
