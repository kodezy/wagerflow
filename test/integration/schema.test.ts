import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { expectLedgersMatch, sql, testOrm } from "../helpers/database";

const HASH = "a".repeat(64);
const NOW = "2026-11-10T12:00:00.000Z";
const TABLES = ["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"];
let orm: MikroORM;

beforeAll(async () => {
  orm = await testOrm();
});

afterAll(async () => {
  await expectLedgersMatch(orm);
  await orm.migrator.down();
  await orm.migrator.up();
  await orm.close();
});

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await sql(orm, `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`, Object.values(row));
}

async function wallet(fields: Record<string, unknown> = {}): Promise<string> {
  const id = Bun.randomUUIDv7();
  await insert("wallets", {
    id,
    player_id: Bun.randomUUIDv7(),
    currency: "BRL",
    balance_amount: "0.00",
    balance_currency: "BRL",
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...fields,
  });

  return id;
}

async function wager(walletId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const id = Bun.randomUUIDv7();
  await insert("wager_transactions", {
    id,
    provider_id: "provider-a",
    external_transaction_id: Bun.randomUUIDv7(),
    idempotency_key: Bun.randomUUIDv7(),
    payload_hash: HASH,
    wallet_id: walletId,
    player_id: "player-1",
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "10.00",
    currency: "BRL",
    status: "REJECTED",
    failure_code: "INSUFFICIENT_BALANCE",
    observed_balance_amount: "0.00",
    observed_balance_currency: "BRL",
    created_at: NOW,
    processed_at: NOW,
    ...fields,
  });

  return id;
}

const processed = { status: "PROCESSED", failure_code: null };

describe("migration", () => {
  test("down removes every table and up restores them", async () => {
    const placeholders = TABLES.map(() => "?").join(", ");
    const tables = () =>
      sql<{ table_name: string }>(
        orm,
        `select table_name from information_schema.tables where table_schema = 'public' and table_name in (${placeholders}) order by 1`,
        TABLES,
      );

    await orm.migrator.down();
    expect(await tables()).toEqual([]);

    await orm.migrator.up();
    expect((await tables()).map((row) => row.table_name)).toEqual(TABLES);
  });
});

describe("wallets", () => {
  test("one wallet per player and currency, never negative, one currency", async () => {
    const playerId = Bun.randomUUIDv7();
    await wallet({ player_id: playerId });

    await expect(wallet({ player_id: playerId })).rejects.toMatchObject({ code: "23505", constraint: "wallets_player_currency_unique" });
    await expect(wallet({ balance_amount: "-0.01" })).rejects.toMatchObject({ code: "23514", constraint: "wallets_balance_non_negative" });
    await expect(wallet({ balance_currency: "USD" })).rejects.toMatchObject({ code: "23514", constraint: "wallets_balance_currency" });
  });
});

describe("wager transactions", () => {
  test("status, uniqueness, and the OPENING shape", async () => {
    const walletId = await wallet();
    const key = Bun.randomUUIDv7();
    await wager(walletId, { idempotency_key: key, external_transaction_id: "ext-1" });

    await expect(
      wager(walletId, {
        status: "PENDING",
        failure_code: null,
        observed_balance_amount: null,
        observed_balance_currency: null,
        processed_at: NOW,
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "wager_transactions_status" });
    await expect(wager(walletId, { idempotency_key: key })).rejects.toMatchObject({ code: "23505", constraint: "wager_transactions_idempotency_key_unique" });
    await expect(wager(walletId, { external_transaction_id: "ext-1" })).rejects.toMatchObject({
      code: "23505",
      constraint: "wager_transactions_provider_external_unique",
    });
    await expect(wager(walletId, { kind: "OPENING", ...processed })).rejects.toMatchObject({ code: "23514", constraint: "wager_transactions_opening_shape" });
    await expect(wager(walletId, { kind: "REFUND" })).rejects.toMatchObject({ code: "23514", constraint: "wager_transactions_reference_shape" });
    await expect(wager(walletId, { amount: "0.00" })).rejects.toMatchObject({ code: "23514", constraint: "wager_transactions_amount" });
    await expect(wager(walletId, { failure_code: null })).rejects.toMatchObject({ code: "23514", constraint: "wager_transactions_failure_shape" });
  });

  test("a target has at most one PROCESSED reversal of any kind", async () => {
    const walletId = await wallet();
    const target = await wager(walletId, processed);
    const reversal = (kind: string, status: Record<string, unknown>) =>
      wager(walletId, { kind, reference_external_transaction_id: "ext", reference_transaction_id: target, ...status });

    await reversal("REFUND", processed);
    await wager(walletId, { kind: "ROLLBACK", reference_external_transaction_id: "ext", failure_code: "REFERENCE_ALREADY_REVERSED" });

    await expect(reversal("ROLLBACK", processed)).rejects.toMatchObject({ code: "23505", constraint: "wager_transactions_reversal_unique" });
  });
});

describe("ledger", () => {
  test("entries balance, stay unique per transaction, and never change", async () => {
    const walletId = await wallet({ balance_amount: "10.00" });
    const transactionId = await wager(walletId, { kind: "WIN", ...processed, observed_balance_amount: "10.00" });
    const entry = {
      wallet_id: walletId,
      transaction_id: transactionId,
      direction: "CREDIT",
      amount: "10.00",
      balance_before: "0.00",
      balance_after: "10.00",
      currency: "BRL",
      created_at: NOW,
    };
    const id = Bun.randomUUIDv7();
    await insert("wallet_ledger_entries", { id, ...entry });

    await expect(insert("wallet_ledger_entries", { id: Bun.randomUUIDv7(), ...entry, balance_after: "9.99" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert("wallet_ledger_entries", { id: Bun.randomUUIDv7(), ...entry })).rejects.toMatchObject({
      code: "23505",
      constraint: "wallet_ledger_entries_transaction_wallet_unique",
    });
    await expect(sql(orm, "update wallet_ledger_entries set amount = 1 where id = ?", [id])).rejects.toMatchObject({ code: "P0001" });
    await expect(sql(orm, "delete from wallet_ledger_entries where id = ?", [id])).rejects.toMatchObject({ code: "P0001" });
    await expect(sql(orm, "truncate wallet_ledger_entries cascade")).rejects.toMatchObject({ code: "P0001" });
  });
});

describe("inbox and outbox", () => {
  test("the inbox key is unique and the outbox schedule is consistent", async () => {
    const inbox = { consumer_name: "wager-transactions", message_id: Bun.randomUUIDv7(), payload_hash: HASH, received_at: NOW, processed_at: NOW };
    await insert("inbox_messages", inbox);
    const outbox = { aggregate_id: "wallet", event_type: "WagerTransactionProcessed", payload: "{}", occurred_at: NOW, attempts: 0 };

    await expect(insert("inbox_messages", inbox)).rejects.toMatchObject({ code: "23505", constraint: "inbox_messages_pkey" });
    await expect(insert("outbox_messages", { id: Bun.randomUUIDv7(), ...outbox, next_attempt_at: null })).rejects.toMatchObject({
      code: "23514",
      constraint: "outbox_messages_schedule",
    });
  });
});
