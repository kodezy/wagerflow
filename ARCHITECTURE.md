# Architecture

## Status

Planned. No runtime in the tree yet. The decisions below are binding for the build.

## Purpose

Wagerflow processes wager operations from game providers over HTTP and SQS. Delivery is at-least-once: duplicates, out-of-order dependents, concurrent instances, and crashes before or after commit are normal. The system must not double-credit, double-debit, drop a committed event, or let a balance go negative.

PostgreSQL is the source of truth for committed balances and outcomes. SQS FIFO ordering and broker deduplication are optimizations.

## System map

```
src/
  wagering/       Money, Wallet, ledger, inbox, outbox, events, submit
  persistence/    MikroORM, migrations, the atomic write
  messaging/      SQS consumer, outbox publisher, pending-reference worker
  http/           controllers, idempotency header, guard
```

The NestJS root only wires these modules. One process runs the HTTP API and the three workers. Several processes run together. A wallet is safe under that concurrency; different wallets proceed in parallel.

## Boundaries

Each module has one reason to change.

### Wagering

Owns the rules and the one submit path shared by HTTP and SQS: open a wallet, submit a wager, resume a pending reference, query, reconcile. Classes keep a `private` or `protected` constructor and static factories (`create`, `from`, `open`, `enqueue`, `receive`). `rehydrate` rebuilds persisted state and does not re-check transition rules.

Defines two ports. `WageringStore` is the only door to SQL: one call commits the wager together with the wallet, ledger, inbox, and outbox rows that outcome writes, and the same port claims due outbox and pending-reference rows. `Clock` supplies `now`.

Does not own HTTP, SQS, acknowledgements, logs, metrics, MikroORM, NestJS, or the ORM's decimal types.

### Persistence

Implements `WageringStore` with MikroORM. Maps `Money` to columns at this edge and rehydrates through `Money.from`. Owns migrations.

Does not decide whether a bet is accepted, and does not record logs or metrics.

### Messaging

Owns the SQS consumer, the outbox publisher, and the pending-reference worker. The consumer calls the same submit as `POST /wagering/transactions`. The worker calls resume on the existing row. The publisher asks the store for due rows and sends them to SQS after the financial commit.

Does not own a second copy of the rules, does not compute the wager `payloadHash`, and does not open its own SQL transaction. It hashes the raw body for the inbox.

### HTTP

Owns request mapping, the idempotency header, status codes, outcome logs, the metrics endpoint, and the guard. Defines `ProviderIdentity`. Health and metrics stay open. The Nest root binds the no-op guard.

Does not apply a wager by itself, does not compute the wager `payloadHash`, and does not publish to the inbound queue.

## Dependency direction

Allowed:

- `http` and `messaging` depend on `wagering`
- `persistence` implements `WageringStore`
- `wagering` depends on its two ports, not on their implementations

Forbidden:

- `wagering` importing NestJS, MikroORM, the AWS SDK, `prom-client`, or a framework decimal column type
- `persistence` importing `prom-client`
- a second business path in the consumer or the worker
- publishing the inbound wager from a controller
- an ORM other than MikroORM
- a separate store for wallet, wager, ledger, inbox, or outbox

## Wagering

Operations on a round: `BET`, then `WIN`, `LOSS`, `REFUND`, or `ROLLBACK`. `OPENING` is created only inside wallet opening. HTTP and SQS cannot submit it.

`Money` is immutable. Every operation returns a new instance. `amount` is a decimal string with scale exactly 2. Currency is ISO-4217. The in-process type is a string-backed decimal (`decimal.js`). Cross-currency arithmetic throws. Input rejects `NaN`, `Infinity`, scientific notation, empty strings, more than two decimal places, and negative amounts. The runtime exercises `BRL`. The type stays multi-currency, and a currency conflict is a domain error.

Persisted amounts are non-negative. Sign lives on `LedgerDirection`.

One wallet per `playerId` + `currency`. `version` starts at `1` after opening and increments only when the balance changes. Opening with a positive balance writes an internal `OPENING` transaction and one `CREDIT` ledger entry in the same SQL transaction, and leaves `version` at `1`. Opening with zero writes neither. The `OPENING` row has no provider, external transaction, round, game, or reference id.

| Kind | Balance | Ledger | Rule |
|---|---|---|---|
| `BET` | debit | one `DEBIT` | reject when the balance cannot cover it |
| `WIN` | credit | one `CREDIT` | may name the `BET` of the same round |
| `LOSS` | none | none | records the result |
| `REFUND` | credit | one `CREDIT` | reverses one `PROCESSED` `BET` |
| `ROLLBACK` | inverse of the reference | one inverted entry | reverses one `PROCESSED` `BET`, `WIN`, or `REFUND` |

`REFUND` and `ROLLBACK` require `referenceExternalTransactionId` at creation. A missing field is an invalid payload. `WIN` may omit it and then applies immediately. `BET` and `LOSS` reject the field as an invalid payload. A present id that is not stored yet becomes `PENDING_REFERENCE`. `WIN` then requires a `BET` of the same scope. The reference resolves by `(providerId, referenceExternalTransactionId)` and must match provider, player, wallet, currency, and round. `REFUND` and `ROLLBACK` amounts must equal the reference. A `WIN` amount is independent of the referenced bet. Partial reversal is out of scope.

A `PROCESSED` transaction has at most one `PROCESSED` reversal of any kind. `REFUND` and `ROLLBACK` on the same target would credit or debit twice. `REJECTED` does not occupy that slot.

`LOSS`, `REJECTED`, and `FAILED` do not change the balance and do not write the ledger. A reversal that would make the balance negative is rejected with `REVERSAL_INSUFFICIENT_BALANCE`, distinct from `INSUFFICIENT_BALANCE` on a bet, and the rejected row stays.

The in-memory object starts at `PENDING`. The insert writes `PROCESSED`, `PENDING_REFERENCE`, `REJECTED`, or `FAILED`, and that is the first committed status. `PENDING_REFERENCE` exits only to `PROCESSED`, `REJECTED`, or `FAILED`. `PROCESSED`, `REJECTED`, and `FAILED` are terminal. A further transition is a programmer error.

`FAILED` is committed only with `PERMANENT_INFRASTRUCTURE`. The payload is valid and the database accepts the commit, but every retry would fail the same way for a reason that is not a business rule: the stored wallet cannot be read back as `Money`, or the integration event cannot be serialized. It does not enqueue an outbox row. The same idempotency key replays that row. A database outage or a lock timeout rolls back and leaves no wager row. A body that cannot be parsed is not stored.

Each financial transaction writes at most one ledger entry for its wallet. `balanceBefore ± money = balanceAfter`, checked in the factory. Entries have no mutators. `observedBalance` is the balance returned for the row's current status. It is set when the row is first stored. If the status later leaves `PENDING_REFERENCE`, it is overwritten with the balance at that terminal decision. After a terminal status it does not change. Replay reads this column and does not read the live wallet.

## Persistence

MikroORM. Unit of Work and identity map stay inside one `EntityManager.transactional()`. `Money` maps to `numeric(19,2)` plus `char(3)`. The mapper formats the numeric as a scale-2 decimal string, then calls `Money.from`. JavaScript `number` never holds an amount.

The financial transaction includes every row that must commit together:

- inbox insert, when the entry is SQS, with `processed_at` set
- wallet balance and version, when the balance changes
- wager transaction insert or status change
- ledger insert, when the operation affects the balance
- outbox insert, when the outcome has an integration event

Isolation is `READ COMMITTED`. The wallet row is the lock. `lock_timeout` is 2s; a timeout is a transient failure and commits nothing.

Migrations are versioned and reversible.

Schema guarantees:

- unique `(player_id, currency)` on wallets
- `balance_amount >= 0`
- wallet currency equals the balance currency
- unique `idempotency_key`; `OPENING` uses `opening:{walletId}`, and its `payload_hash` is the canonical hash over the fields it has
- unique `(provider_id, external_transaction_id)` where both are present; on `OPENING`, provider, external transaction, round, game, and reference ids are null
- partial unique index on `reference_transaction_id` where `kind` is `REFUND` or `ROLLBACK` and `status` is `PROCESSED`
- unique `(transaction_id, wallet_id)` on ledger entries
- ledger `UPDATE` and `DELETE` rejected by trigger
- check constraint that `balance_after` equals `balance_before` plus or minus `amount` according to direction
- unique `(consumer_name, message_id)` on the inbox; `message_id` is the body `messageId`; `payload_hash` is the raw-body SHA-256 and is not null
- amounts are `numeric(19,2)`, never float

A unique-violation on the reversal index becomes `REFERENCE_ALREADY_REVERSED` when the other commit won. A unique-violation on the idempotency key re-reads the stored row and either replays or returns a payload conflict. A unique-violation on `(provider_id, external_transaction_id)` with a different key leaves the stored row unchanged and returns `DUPLICATE_EXTERNAL_TRANSACTION`. A unique-violation on `(consumer_name, message_id)` re-reads the inbox row in that transaction. The same raw-body hash returns the stored wager outcome and applies nothing else. A different hash leaves the inbox row and the wager unchanged.

## Concurrency

The lock scope is `walletId`. `LockMode.PESSIMISTIC_WRITE` on the wallet row serializes debits and credits for that player. Wallets do not share a lock, a mutex, or an advisory lock.

`version` is updated in that same `UPDATE` and only when the balance changes. The second transaction waits on the row lock, then reads the balance the first commit left. It does not fail because it waited.

Two bets of `80.00` against `100.00` produce one `PROCESSED` bet, one `REJECTED` bet with `INSUFFICIENT_BALANCE`, balance `20.00`, and one debit entry.

Trade-off: a hot wallet serializes. Optimistic retry alone needs a careful lost-update loop and still loses to a unique constraint race. The row lock makes the critical section obvious. FIFO on `walletId` only shortens the queue.

## Idempotency

PostgreSQL stores the outcome. The idempotency key identifies the wager request. On `POST /wagering/transactions` the key is the `Idempotency-Key` header. On SQS it is `data.idempotencyKey`. Submit receives that one value. The usual value is `{providerId}:{externalTransactionId}`. A missing key on that POST is an invalid payload. A message without `data.idempotencyKey` cannot be stored. Wallet creation, reads, reconciliation, health, and metrics do not use this header.

`payloadHash` is SHA-256 (hex) of canonical JSON: object keys sorted at every level, no insignificant whitespace, business fields only.

Hashed fields: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, and `referenceExternalTransactionId` only when the caller sent it. An omitted field is absent from the canonical JSON. `null` and a missing field are the same shape, so they do not produce two hashes. The header, `messageId`, timestamps, and transport metadata are outside the hash. Keys are opaque strings up to 255 characters.

`wagering` computes this hash. `http` and `messaging` pass the business fields and do not compute this canonical hash. The inbox `payloadHash` is a hash of the raw body, not this canonical hash.

The same key and hash return the stored row with `idempotentReplay: true`. While the row is `PENDING_REFERENCE`, that replay stays `202`. Once the row is terminal, every later replay returns that terminal result. The same key and a different hash return `409` `IDEMPOTENCY_PAYLOAD_CONFLICT` and do not change the stored row. The same `(providerId, externalTransactionId)` with a different key returns `409` `DUPLICATE_EXTERNAL_TRANSACTION` and does not change the stored row. Memory, a process-local map, or SQS deduplication is not the record.

## HTTP

| Situation | Status | Body |
|---|---|---|
| Wallet created | `201` | wallet, `version` 1 |
| Duplicate wallet (`playerId` + currency) | `409` | `DUPLICATE_WALLET` |
| Invalid payload, bad money, or missing `Idempotency-Key` on `POST /wagering/transactions` | `400` | validation code |
| Applied or rejected outcome, including replay | `200` | `transactionId`, status, `balance`, `idempotentReplay` |
| Accepted as `PENDING_REFERENCE`, including replay | `202` | `transactionId`, status, `balance`, `idempotentReplay` |
| Idempotency key reused with a different payload | `409` | `IDEMPOTENCY_PAYLOAD_CONFLICT` |
| Same provider transaction id, different key | `409` | `DUPLICATE_EXTERNAL_TRANSACTION` |
| Transient PostgreSQL outage or lock timeout | `503` | retryable, nothing stored |
| Stored `FAILED`, including replay | `500` | `failureCode` |

The JSON field `balance` is the row's `observedBalance`. `200` with `REJECTED` means the outcome is stored. The provider must not retry that payload expecting a new financial effect. `503` is safe to retry with the same key. An SQS outage does not fail an HTTP submit: the outbox row is already committed, readiness goes not-ready, and the publisher retries.

Reads: `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `GET /wagering/transactions/:transactionId`, and `GET /providers/:providerId/wagering/transactions/:externalTransactionId`. Unknown ids are `404`.

Ledger pagination is a keyset cursor on `(created_at, id)`, opaque and stable. Reconciliation returns `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, and `checkedEntries`. `calculatedBalance` is the fold of the ledger. `difference` is `storedBalance − calculatedBalance`. `consistent` is true only when the difference is zero. `checkedEntries` is how many ledger rows were folded. A non-zero difference increments the reconciliation mismatch metric and is returned. Nothing is rewritten.

`GET /health/live` is the process. `GET /health/ready` requires PostgreSQL and SQS. Neither route uses the auth guard.

## Failure codes

| Code | When |
|---|---|
| `INSUFFICIENT_BALANCE` | `BET` does not fit the balance |
| `REVERSAL_INSUFFICIENT_BALANCE` | a reversal would go negative |
| `REFERENCE_NOT_FOUND` | `PENDING_REFERENCE` exhausted its attempts |
| `REFERENCE_KIND_MISMATCH` | `WIN` or `REFUND` not aimed at a `BET`, or `ROLLBACK` not aimed at `BET`, `WIN`, or `REFUND` |
| `REFERENCE_NOT_PROCESSED` | the reference is stored as `REJECTED` or `FAILED` |
| `REFERENCE_SCOPE_MISMATCH` | provider, player, wallet, currency, or round differs |
| `REFERENCE_ALREADY_REVERSED` | the target already has a `PROCESSED` reversal |
| `AMOUNT_MISMATCH` | reversal amount differs from the reference |
| `CURRENCY_MISMATCH` | operation currency differs from the wallet or the reference |
| `OPENING_NOT_ACCEPTED` | HTTP or SQS submitted `OPENING` |
| `WALLET_NOT_FOUND` | unknown wallet |
| `PERMANENT_INFRASTRUCTURE` | stored wallet cannot be read back as `Money`, or the integration event cannot be serialized |

`IDEMPOTENCY_PAYLOAD_CONFLICT`, `DUPLICATE_EXTERNAL_TRANSACTION`, and `DUPLICATE_WALLET` are HTTP conflicts. They are not transaction statuses. `DUPLICATE_WALLET` exists only on `POST /wallets`. On SQS, a payload conflict or a duplicate external transaction is acknowledged and leaves the stored wager unchanged.

## Pending references

A scheduled worker claims due `PENDING_REFERENCE` rows with `FOR UPDATE SKIP LOCKED` and resumes that row. It does not open a second submit and does not allocate another idempotency key. After a miss, the next wait is 1s and doubles on each later miss, capped at 60s. The 12th miss rejects. Those waits are 1+2+4+8+16+32+60+60+60+60+60 seconds, about 6 minutes from the first try to rejection. That covers reordering and a short provider lag. A reference that never arrives is a provider fault, not an open hold. On exhaustion the status becomes `REJECTED` with `REFERENCE_NOT_FOUND`, and `WagerTransactionRejected` is enqueued in that same transaction. A missing reference keeps waiting. Kind or scope mismatch, a reversal whose amount differs, or a reference already `REJECTED` or `FAILED`, is rejected on that attempt. A `WIN` amount is not compared with the bet. A reference that is still `PENDING_REFERENCE` stays waiting.

Attempt count and `next_attempt_at` live on the wager transaction. They are not SQS receive counts.

## Messaging

Local AWS is **MiniStack** (`ministackorg/ministack`) on port `4566`, region `us-east-1`, access key `test`. The app uses `@aws-sdk/client-sqs` with `SQS_ENDPOINT`. PostgreSQL is `postgres:16`.

Inbound queues: `wager-transactions.fifo` and `wager-transactions-dlq.fifo`. Message group id is `walletId`. Content-based deduplication is off on both. Every send sets a new `MessageDeduplicationId`, so an identical body still arrives. HTTP calls submit directly and do not enqueue that request. SQS is a second ingress, not a side effect of HTTP. Tests and a local producer publish `WagerTransactionRequested` straight to the inbound queue. The inbox `consumerName` is `wager-transactions`.

The consumer long-polls up to 10 messages (wait 10s) and runs different wallets in parallel, up to 5 at a time. Messages for the same `walletId` in one batch run one after another. Visibility timeout is 30s. The inbox key is the body `messageId`. The consumer hashes the exact raw body, SHA-256 hex, and passes that hash with the business fields into submit. The inbox row is inserted with `processed_at` set. Acknowledge deletes by the SQS receipt handle, and only after commit. A body that cannot be parsed, or that has no `messageId` or no `data.idempotencyKey`, cannot be stored.

| Error class | Action |
|---|---|
| Stored outcome (`PROCESSED`, `REJECTED`, `FAILED`, `PENDING_REFERENCE`), including replay | acknowledge |
| Same key with a different payload, or same provider transaction id with a different key | acknowledge, stored row unchanged |
| Same body `messageId` and the same raw-body hash | acknowledge, no second effect |
| Same body `messageId` and a different raw-body hash | acknowledge, inbox row and wager unchanged |
| Transient (database down, lock timeout) | leave the message; visibility timeout is the backoff |
| Body that cannot be parsed or stored | send to the DLQ, then acknowledge the source |

SQS redrive `maxReceiveCount` is 5. The DLQ send uses group id `walletId`, or `unparsed` when the body has no wallet id, and `MessageDeduplicationId` equal to the body `messageId`, or the SQS `MessageId` when the body has none. On `SIGTERM` the process stops receiving, waits up to 20s for in-flight work, then sets visibility to 0 on anything still open.

## Outbox

`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, and `WagerTransactionPendingReference` are subclasses of `IntegrationEvent`. `eventType` and `version` live on the class. The envelope carries `eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, optional `causationId`, `occurredAt`, and `data`. `aggregateId` is the `walletId`. `toJSON()` writes `MoneyProps` strings, never a `Money` instance. `eventId` is assigned when the outbox row is inserted, so a republish keeps the same id.

`WagerTransactionProcessed` is enqueued for every applied transaction, including `LOSS` and internal `OPENING`. `WalletBalanceChanged` is enqueued only when the balance changes, which includes `OPENING` with a positive amount and excludes `LOSS`. `WagerTransactionPendingReference` is enqueued in the same transaction that first stores `PENDING_REFERENCE`. `WagerTransactionRejected` is enqueued when a row becomes `REJECTED`. `FAILED` stores no outbox event: the row is the audit record, and nothing was applied.

`WalletBalanceChanged` data is `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, and `walletVersion`. `money`, `balanceBefore`, and `balanceAfter` are `MoneyProps`.

`WagerTransactionProcessed`, `WagerTransactionRejected`, and `WagerTransactionPendingReference` carry `transactionId`, `walletId`, `playerId`, `kind`, `money`, `balance`, `providerId`, `externalTransactionId`, `roundId`, `gameId`, and `referenceExternalTransactionId`. `money` is `MoneyProps`. `balance` is the `observedBalance` written in that commit. An identifier the row does not have is `null`. `WagerTransactionRejected` also carries `failureCode`.

The publisher polls every 500ms, claims up to 20 due rows with `FOR UPDATE SKIP LOCKED`, and sends each body to `integration-events.fifo`. Message group id is `aggregateId`. Deduplication id is `eventId`. Content-based deduplication stays off. Crash after commit and before publish leaves `published_at` null; another instance publishes. Crash after publish and before the mark causes one duplicate delivery with the same `eventId`. Downstream consumers dedupe on `eventId`. `scheduleRetry` increments `attempts` and sets `nextAttemptAt` from 1s, doubling, capped at 60s. There is no attempt ceiling. A committed event is retried until `published_at` is set.

## Authentication

This service does not store users or password hashes. The intended edge is an external OIDC provider (Keycloak or Zitadel): bearer JWT, checked by a guard, with provider identity separate from `playerId`.

The Nest root binds a no-op `AuthGuard` that satisfies `ProviderIdentity`. Keycloak and Zitadel are not in Compose. Health and `GET /metrics` stay public. SQS is a trusted internal channel. `providerId` in the payload is a wager field: submit checks it against the wallet and the reference scope. That check is not `ProviderIdentity`.

## Observability

`http` and `messaging` write one JSON object per outcome to stdout. `wagering` and `persistence` do not log. There is no log port.

A line carries `correlationId` and, when the outcome has them, `transactionId`, `walletId`, `providerId`, `status`, and `failureCode`. `messageId` on a queue delivery is the body `messageId`. Lines omit the request body, money amounts, tokens, and secrets.

`msg` is `wager.submitted`, `wallet.opened`, `reconciliation.mismatch`, `sqs.acknowledged`, `sqs.redelivered`, or `sqs.dlq`. `wager.submitted` includes `idempotentReplay`. `reconciliation.mismatch` is the non-zero reconciliation and carries `walletId` and `consistent: false`. The publisher does not log the event body. `sqs.redelivered` is the one line for an inbox hit with the same raw-body hash. `sqs.acknowledged` is the one line for an inbox hash mismatch, an idempotency payload conflict, or a duplicate external transaction on SQS. `sqs.dlq` is the one line when the body is sent to the DLQ. Those three lines are not paired with `wager.submitted`. An idempotent replay logs `wager.submitted`.

HTTP reads `X-Correlation-Id` or generates one. A queue delivery uses the body `messageId` as the `correlationId` on the log line and on the integration event.

The Nest root creates one `prom-client` registry and passes it to `http` and `messaging`. `GET /metrics` reads that registry. The edge that handled the call records the outcome. A status count moves when a wager row is inserted or its status changes. An idempotent replay and a same-hash inbox hit each increment the duplicate count once, and a same-hash inbox hit is not also counted as an idempotent replay. A payload conflict and an inbox hash mismatch are not part of that count. `http` also records its lock conflicts, its processing latency, and reconciliation mismatches. `messaging` also records its lock conflicts, its processing latency, retries, DLQ depth, and outbox lag. Outbox lag is the age of the oldest unpublished row. There is no metrics port. Timestamps use the `Clock` defined by wagering. Production binds the system clock. Unit tests bind a fake clock. OpenTelemetry is optional and not part of this design.

Generated ids (wallet, wager transaction, ledger entry, integration `eventId`) are UUID v7. `playerId`, `providerId`, and `externalTransactionId` stay caller-supplied opaque strings.

Configuration is environment variables: `DATABASE_URL`, `SQS_ENDPOINT`, `SQS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`, `SQS_EVENTS_QUEUE_URL`. Attempt limits and backoff caps have the defaults in this document and may be overridden the same way in tests.

## Verification

Commands are not configured yet. The suite that must exist:

- unit tests for `Money`, wallet invariants, each kind, currency conflict, and idempotency payload conflict
- integration tests against real PostgreSQL 16 and MiniStack: migrations, constraints, the atomic write, inbox redelivery, concurrent publishers, retry, DLQ, restart
- real parallelism: 50 duplicate bets → one debit (each SQS send uses a new `MessageDeduplicationId`; a shared body `messageId` collapses in the inbox, and a shared idempotency key with distinct body `messageId`s collapses on that key); the hot-wallet case; distinct wallets in parallel; at least three processes; kill after commit and before ack; two publishers; reversal before its reference; restart with the ledger still matching the balance

Every test ends at `wallet.balance == fold(ledger)`.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| ORM | MikroORM | Unit of Work, identity map, `transactional()`, and `LockMode` match the one-transaction write |
| Lock | Pessimistic write on the wallet row, plus `version` | The hot-wallet case is one critical section. `version` still moves only on a balance change |
| Amount sign | Non-negative stored amount, direction on the entry | Input contracts reject negatives. Rollback flips `DEBIT` / `CREDIT` |
| Replay balance | `observedBalance` on the row | Replay reads that column. It changes only when `PENDING_REFERENCE` becomes terminal |
| Reversal uniqueness | One `PROCESSED` reversal per target, any kind | Per-kind uniqueness alone would let `REFUND` and `ROLLBACK` both apply |
| Modules | `wagering`, `persistence`, `messaging`, `http` | Each one changes for a different reason. The Nest root only wires them |
| Store | One `WageringStore` | Wallet, wager, ledger, inbox, and outbox commit together. Split stores could save a balance without a ledger |
| Auth | No-op guard, `ProviderIdentity` | Credentials stay in an external IdP. The wager path does not depend on it |
| Double-entry ledger | Single entry per effect | A balanced pair is optional. The materialized balance plus one immutable entry is the audit trail |
| Currency | Model is multi-currency; runtime uses `BRL` | Cuts fixture scope. Conflict tests still cross currencies |
| SQS emulator | MiniStack on port 4566 | Same SDK contract as AWS, small image, no license key. LocalStack stays unused |
| Ingress | HTTP applies directly; SQS is a second ingress | Forwarding HTTP into the queue would apply the wager twice |
| Outbox destination | `integration-events.fifo`, dedup id = `eventId` | One queue is enough. SNS fan-out is unnecessary. Republish stays safe |
| Identifiers | UUID v7 for ids this service mints | Time-ordered keys match the ledger cursor. Caller ids stay opaque strings |
| Metrics | `prom-client` on `GET /metrics` | Covers the required counters without an OpenTelemetry stack |
| Reference on `WIN` | Optional. Present and missing → `PENDING_REFERENCE`, and the target must be a `BET` | `BET` and `LOSS` reject the field. Reversals still require it |
| Pending status | The insert writes the outcome status | A resting `PENDING` row has no API result and no resume worker |
| Canonical hash | `wagering` computes it | Separate hashes in `http` and `messaging` can disagree on the same fields |
| Inbound FIFO | Content-based dedup off; each send sets its own `MessageDeduplicationId` | Fifty identical bodies must reach the app. A repeated body `messageId` collapses in the inbox. A repeated wager key collapses on that key |
| Inbox identity | Body `messageId` and raw-body SHA-256 | The same id with a different body leaves the stored rows unchanged |
| Logs and metrics | JSON on stdout; one `prom-client` registry composed at the root | `wagering` and `persistence` stay free of the logger and the client |

## Limitations

- No partial refunds or rollbacks.
- No double-entry ledger.
- No identity server in Compose. The guard is a no-op until an OIDC adapter is bound.
- HTTP submit does not publish to `wager-transactions.fifo`. Producers and tests do.
- No OpenTelemetry pipeline.
- Load testing is outside this design. If added later, the entry is `bun run test:load`.
- Ready checks report reachability of PostgreSQL and SQS, not end-to-end wager success.

## Freshness

Last updated: 2026-11-10
