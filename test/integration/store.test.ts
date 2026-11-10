import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { createOrm } from "../../src/persistence/orm";
import { PostgresWageringStore } from "../../src/persistence/store";
import { systemClock } from "../../src/wagering/clock";
import { ConflictCode, FailureCode } from "../../src/wagering/errors";
import { WagerTransactionProcessed } from "../../src/wagering/events";
import { InboxMessage } from "../../src/wagering/inbox";
import { OutboxMessage } from "../../src/wagering/outbox";
import { QueryWagering } from "../../src/wagering/query";
import type { WagerRequest } from "../../src/wagering/request";
import { TransientStoreError } from "../../src/wagering/store";
import { SubmitWager } from "../../src/wagering/submit";
import { WagerTransaction, WagerTransactionStatus } from "../../src/wagering/transaction";
import { deferred } from "../helpers/async";
import { expectLedgersMatch, sql, testOrm, UNREACHABLE_DATABASE_URL } from "../helpers/database";
import { expectOutcome, openWallet, wagerRequest } from "../helpers/wagering";

let orm: MikroORM;
let store: PostgresWageringStore;
let submit: SubmitWager;

beforeAll(async () => {
  orm = await testOrm();
  store = new PostgresWageringStore(orm);
  submit = new SubmitWager(store, systemClock);
});

afterAll(async () => {
  await expectLedgersMatch(orm);
  await orm.close();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

function transactionFrom(request: WagerRequest): WagerTransaction {
  return WagerTransaction.create({ ...request, id: Bun.randomUUIDv7(), createdAt: new Date() });
}

async function count(table: string, column: string, value: string): Promise<number> {
  const [row] = await sql<{ total: number }>(orm, `select count(*)::int as total from ${table} where ${column} = ?`, [value]);
  return row?.total ?? 0;
}

describe("PostgresWageringStore", () => {
  test("opening, submit, and replay round-trip through PostgreSQL", async () => {
    const wallet = await openWallet(store, systemClock);
    const request = wagerRequest(wallet);
    const first = expectOutcome(await submit.execute({ request, correlationId: "c" }));
    const replay = expectOutcome(await submit.execute({ request, correlationId: "c" }));

    expect(first).toMatchObject({ status: WagerTransactionStatus.Processed, balance: brl("75.00") });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect((await store.findWallet(wallet.id))?.toState()).toMatchObject({ version: 2 });
    expect(await count("wallet_ledger_entries", "wallet_id", wallet.id)).toBe(2);
    expect(await count("outbox_messages", "aggregate_id", wallet.id)).toBe(4);
  });

  test("a failed write leaves wallet, wager, ledger, inbox, and outbox untouched", async () => {
    const wallet = await openWallet(store, systemClock);
    const request = wagerRequest(wallet);
    const messageId = Bun.randomUUIDv7();

    const attempt = store.inWallet(wallet.id, async (session) => {
      const locked = await session.lockWallet(wallet.id);
      if (!locked) throw new Error("wallet missing");
      const at = new Date();
      const transaction = transactionFrom(request);
      const entry = locked.debit({ entryId: Bun.randomUUIDv7(), transactionId: transaction.id, money: transaction.money, at });
      transaction.markProcessed(undefined, locked.balance, at);
      const message = OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, { correlationId: "c", occurredAt: at }));
      const inbox = InboxMessage.receive({ consumerName: "wager-transactions", messageId, payloadHash: "b".repeat(64), receivedAt: at });
      inbox.markProcessed(at);

      await session.save({ transaction, isNew: true, wallet: locked, entry, inbox, outbox: [message, message] });
    });

    await expect(attempt).rejects.toMatchObject({ code: "23505" });
    expect((await store.findWallet(wallet.id))?.balance.toJSON()).toEqual(brl("100.00"));
    expect(await count("wager_transactions", "idempotency_key", request.idempotencyKey)).toBe(0);
    expect(await count("wallet_ledger_entries", "wallet_id", wallet.id)).toBe(1);
    expect(await count("inbox_messages", "message_id", messageId)).toBe(0);
    expect(await count("outbox_messages", "aggregate_id", wallet.id)).toBe(2);
  });

  test("a unique violation rolls back only the savepoint and submit re-reads the winner", async () => {
    const holderWallet = await openWallet(store, systemClock);
    const rivalWallet = await openWallet(store, systemClock);
    const key = `shared-${Bun.randomUUIDv7()}`;
    const saved = deferred();
    const release = deferred();

    const holder = store.inWallet(holderWallet.id, async (session) => {
      await session.lockWallet(holderWallet.id);
      const transaction = transactionFrom(wagerRequest(holderWallet, {}, key));
      transaction.reject(FailureCode.InsufficientBalance, holderWallet.balance, new Date());
      await session.save({ transaction, isNew: true, outbox: [] });
      saved.resolve();
      await release.promise;
    });

    await saved.promise;
    const racing = submit.execute({ request: wagerRequest(rivalWallet, {}, key), correlationId: "c" });
    await Bun.sleep(300);
    release.resolve();
    await holder;

    expect(await racing).toMatchObject({ type: "conflict", code: ConflictCode.IdempotencyPayloadConflict });
    expect(await count("wager_transactions", "idempotency_key", key)).toBe(1);
    expect((await store.findWallet(rivalWallet.id))?.balance.toJSON()).toEqual(brl("100.00"));
  });

  test("a stored wallet that is not valid Money stores FAILED without an event", async () => {
    const id = Bun.randomUUIDv7();
    const playerId = Bun.randomUUIDv7();
    await sql(orm, "insert into wallets values (?, ?, 'brl', 0.00, 'brl', 1, now(), now())", [id, playerId]);

    const outcome = expectOutcome(await submit.execute({ request: wagerRequest({ id, playerId }, { money: brl("1.00") }), correlationId: "c" }));

    expect(outcome).toMatchObject({ status: WagerTransactionStatus.Failed, failureCode: FailureCode.PermanentInfrastructure, balance: null });
    expect(await count("outbox_messages", "aggregate_id", id)).toBe(0);
  });

  test("an unknown or non-UUID wallet id is stored as WALLET_NOT_FOUND", async () => {
    const outcome = expectOutcome(await submit.execute({ request: wagerRequest({ id: "not-a-uuid", playerId: "p" }), correlationId: "c" }));

    expect(outcome).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.WalletNotFound });
    expect(await store.findWallet("not-a-uuid")).toBeUndefined();
    expect(await count("outbox_messages", "aggregate_id", "not-a-uuid")).toBeGreaterThan(0);
  });

  test("a lock timeout is transient and commits nothing", async () => {
    const wallet = await openWallet(store, systemClock);
    const locked = deferred();
    const release = deferred();
    const holder = store.inWallet(wallet.id, async (session) => {
      await session.lockWallet(wallet.id);
      locked.resolve();
      await release.promise;
    });

    await locked.promise;
    await expect(submit.execute({ request: wagerRequest(wallet), correlationId: "c" })).rejects.toMatchObject({ reason: "lock_timeout" });
    release.resolve();
    await holder;

    expect(await count("wallet_ledger_entries", "wallet_id", wallet.id)).toBe(1);
  });

  test("an unreachable database is transient", async () => {
    const unreachable = await createOrm(UNREACHABLE_DATABASE_URL);
    const down = new PostgresWageringStore(unreachable);

    await expect(down.ping()).rejects.toBeInstanceOf(TransientStoreError);
    await expect(down.inWallet(Bun.randomUUIDv7(), async () => undefined)).rejects.toMatchObject({ reason: "unavailable" });
    await unreachable.close().catch(() => undefined);
  });

  test("outbox claims skip rows another publisher holds and store the new state", async () => {
    await openWallet(store, systemClock);
    const held = deferred();
    const release = deferred();
    let first: string[] = [];
    let second: string[] = [];

    const holder = store.claimOutbox(new Date(), 1000, async (messages) => {
      first = messages.map((message) => message.id);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    await store.claimOutbox(new Date(), 1000, async (messages) => {
      second = messages.map((message) => message.id);
    });
    release.resolve();
    await holder;

    expect(first.length).toBeGreaterThan(0);
    expect(first.filter((id) => second.includes(id))).toEqual([]);

    const now = new Date();
    await store.claimOutbox(now, 1000, async (messages) => {
      messages[0]?.scheduleRetry(now);
      for (const message of messages.slice(1)) message.markPublished(now);
    });
    const [retried] = await sql<{ attempts: number }>(orm, "select attempts from outbox_messages where published_at is null and attempts > 0 limit 1");

    expect(retried?.attempts).toBe(1);
  });

  test("ledger pages follow (created_at, id) without gaps", async () => {
    const wallet = await openWallet(store, systemClock);
    for (let bet = 0; bet < 3; bet += 1) await submit.execute({ request: wagerRequest(wallet, { money: brl("1.00") }), correlationId: "c" });
    const query = new QueryWagering(store);

    const first = await query.ledger(wallet.id, { limit: "3" });
    const second = await query.ledger(wallet.id, { limit: "3", cursor: first?.nextCursor ?? undefined });
    const ids = [...(first?.items ?? []), ...(second?.items ?? [])].map((item) => item.id);

    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(second?.nextCursor).toBeNull();
  });
});
