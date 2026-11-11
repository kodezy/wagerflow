import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";

import { createApp } from "../../src/app";
import { createOrm } from "../../src/persistence/orm";
import { ORM } from "../../src/persistence/module";
import { expectLedgersMatch, TEST_DATABASE_URL } from "../helpers/database";
import { testQueues } from "../helpers/infra";

let app: INestApplication;
let orm: MikroORM;
let base: string;

beforeAll(async () => {
  const migrator = await createOrm(TEST_DATABASE_URL);
  await migrator.migrator.up();
  await migrator.close();
  const { config } = await testQueues();
  app = await createApp(config);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  orm = app.get(ORM);
});

afterAll(async () => {
  await expectLedgersMatch(orm);
  await app.close();
});

async function http(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

async function json(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await http(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

describe("HTTP", () => {
  test("opens a wallet, bets, replays, and rejects a payload conflict", async () => {
    const opened = await json("/wallets", {
      method: "POST",
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: "100.00", currency: "BRL" } }),
    });
    expect(opened.status).toBe(201);
    expect(opened.body.version).toBe(1);

    const walletId = opened.body.id as string;
    const playerId = opened.body.playerId as string;
    const duplicate = await json("/wallets", {
      method: "POST",
      body: JSON.stringify({ playerId, initialBalance: { amount: "1.00", currency: "BRL" } }),
    });
    expect(duplicate).toMatchObject({ status: 409, body: { code: "DUPLICATE_WALLET" } });
    const externalId = `tx-${Bun.randomUUIDv7()}`;
    const bet = {
      providerId: "provider-a",
      externalTransactionId: externalId,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };
    const headers = { "Idempotency-Key": `provider-a:${externalId}`, "X-Correlation-Id": "c-1" };

    const first = await json("/wagering/transactions", { method: "POST", headers, body: JSON.stringify(bet) });
    const replay = await json("/wagering/transactions", { method: "POST", headers, body: JSON.stringify(bet) });
    const conflict = await json("/wagering/transactions", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...bet, money: { amount: "26.00", currency: "BRL" } }),
    });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "PROCESSED", idempotentReplay: false, failureCode: null });
    expect(replay.body).toMatchObject({ transactionId: first.body.transactionId, idempotentReplay: true });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_PAYLOAD_CONFLICT");
  });

  test("validation, opening, not found, ready, live, and metrics", async () => {
    const missingKey = await json("/wagering/transactions", { method: "POST", body: JSON.stringify({ kind: "BET" }) });
    const opening = await json("/wagering/transactions", {
      method: "POST",
      headers: { "Idempotency-Key": "k" },
      body: JSON.stringify({
        providerId: "p",
        externalTransactionId: "e",
        playerId: "pl",
        walletId: "w",
        roundId: "r",
        gameId: "g",
        kind: "OPENING",
        money: { amount: "1.00", currency: "BRL" },
      }),
    });
    const unknown = await json("/wallets/not-a-uuid");
    const live = await http("/health/live");
    const ready = await json("/health/ready");
    const metrics = await http("/metrics");

    expect(missingKey).toMatchObject({ status: 400, body: { code: "IDEMPOTENCY_KEY_REQUIRED", field: "idempotencyKey" } });
    expect(opening).toMatchObject({ status: 400, body: { code: "OPENING_NOT_ACCEPTED", field: "kind" } });
    expect(unknown).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(await metrics.text()).toContain("wagerflow_transactions_total");
  });

  test("WIN whose BET is not stored yet is 202", async () => {
    const opened = await json("/wallets", {
      method: "POST",
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: "10.00", currency: "BRL" } }),
    });
    const walletId = opened.body.id as string;
    const playerId = opened.body.playerId as string;
    const winId = `win-${Bun.randomUUIDv7()}`;
    const win = await json("/wagering/transactions", {
      method: "POST",
      headers: { "Idempotency-Key": `provider-a:${winId}` },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: winId,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "WIN",
        money: { amount: "5.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
      }),
    });

    expect(win.status).toBe(202);
    expect(win.body.status).toBe("PENDING_REFERENCE");
  });
});
