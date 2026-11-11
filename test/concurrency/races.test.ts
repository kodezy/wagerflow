import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";

import { createApp } from "../../src/app";
import { WagerConsumer } from "../../src/messaging/consumer";
import { SqsGateway } from "../../src/messaging/sqs";
import { Metrics } from "../../src/observability";
import { ORM } from "../../src/persistence/module";
import { CLOCK, systemClock } from "../../src/wagering/clock";
import type { WagerOutcome } from "../../src/wagering/apply";
import { FailureCode } from "../../src/wagering/errors";
import { SubmitWager } from "../../src/wagering/submit";
import { WagerTransactionStatus } from "../../src/wagering/transaction";
import { expectLedgersMatch } from "../helpers/database";
import { requested, testQueues } from "../helpers/infra";
import { waitFor } from "../helpers/async";

let app: INestApplication;
let orm: MikroORM;
let base: string;
let sqs: SqsGateway;

beforeAll(async () => {
  const setup = await testQueues();
  app = await createApp(setup.config);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  orm = app.get(ORM);
  sqs = app.get(SqsGateway);
  await orm.migrator.up();
});

afterAll(async () => {
  await expectLedgersMatch(orm);
  await app.close();
});

async function openWallet(): Promise<{ id: string; playerId: string }> {
  const response = await fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: "100.00", currency: "BRL" } }),
  });
  return (await response.json()) as { id: string; playerId: string };
}

type WalletView = { balance: { amount: string } };

function bet(wallet: { id: string; playerId: string }, externalTransactionId: string, amount = "25.00") {
  return {
    providerId: "provider-a",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

describe("races", () => {
  const tag = () => Bun.randomUUIDv7().replaceAll("-", "").slice(0, 12);

  test("50 duplicate HTTP bets debit once", async () => {
    const wallet = await openWallet();
    const externalId = `dup-http-${tag()}`;
    const body = JSON.stringify(bet(wallet, externalId));
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${externalId}` },
          body,
        }),
      ),
    );
    const payloads = await Promise.all(
      responses.map(async (response) => ({ status: response.status, body: (await response.json()) as WagerOutcome })),
    );
    const walletState = (await (await fetch(`${base}/wallets/${wallet.id}`)).json()) as WalletView;

    expect(new Set(payloads.map((item) => item.body.transactionId))).toHaveLength(1);
    expect(walletState.balance.amount).toBe("75.00");
  });

  test("50 SQS copies with one messageId debit once", async () => {
    const wallet = await openWallet();
    const messageId = Bun.randomUUIDv7();
    const body = requested(wallet, { money: { amount: "10.00", currency: "BRL" } }, messageId);
    const consumer = new WagerConsumer(sqs, app.get(SubmitWager), app.get(Metrics), app.get(CLOCK), 5_000);
    consumer.start();
    await Promise.all(Array.from({ length: 50 }, () => sqs.sendWager(body, wallet.id, Bun.randomUUIDv7())));
    await waitFor(async () => {
      const current = (await (await fetch(`${base}/wallets/${wallet.id}`)).json()) as WalletView;
      return current.balance.amount === "90.00" ? true : undefined;
    });
    await consumer.stop();
  });

  test("50 SQS messages sharing a key with distinct messageIds debit once", async () => {
    const wallet = await openWallet();
    const externalId = `shared-key-${tag()}`;
    const consumer = new WagerConsumer(sqs, app.get(SubmitWager), app.get(Metrics), app.get(CLOCK), 5_000);
    consumer.start();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        sqs.sendWager(
          requested(wallet, { externalTransactionId: externalId, idempotencyKey: `provider-a:${externalId}` }),
          wallet.id,
          Bun.randomUUIDv7(),
        ),
      ),
    );
    await waitFor(async () => {
      const current = (await (await fetch(`${base}/wallets/${wallet.id}`)).json()) as WalletView;
      return current.balance.amount === "75.00" ? true : undefined;
    });
    await consumer.stop();
  });

  test("two concurrent 80.00 bets against 100.00 leave 20.00 and one debit", async () => {
    const wallet = await openWallet();
    const run = tag();
    const responses = await Promise.all(
      ["a", "b"].map((id) => {
        const externalId = `${run}-${id}`;
        return fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${externalId}` },
          body: JSON.stringify(bet(wallet, externalId, "80.00")),
        });
      }),
    );
    const bodies = await Promise.all(responses.map(async (response) => (await response.json()) as WagerOutcome));
    const walletState = (await (await fetch(`${base}/wallets/${wallet.id}`)).json()) as WalletView;
    const statuses = bodies.map((body) => body.status).sort();
    const rejected = bodies.find((body) => body.status === WagerTransactionStatus.Rejected);

    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    expect(rejected?.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(walletState.balance.amount).toBe("20.00");
  });

  test("distinct wallets proceed in parallel", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet()));
    const run = tag();
    const started = Date.now();
    await Promise.all(
      wallets.map((wallet, index) => {
        const externalId = `${run}-w${index}`;
        return fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${externalId}` },
          body: JSON.stringify(bet(wallet, externalId, "1.00")),
        });
      }),
    );

    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("a REFUND before its BET waits, then credits once", async () => {
    const wallet = await openWallet();
    const run = tag();
    const betExternal = `${run}-bet-late`;
    const refundExternal = `${run}-refund`;
    const refund = await fetch(`${base}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${refundExternal}` },
      body: JSON.stringify({ ...bet(wallet, refundExternal, "10.00"), kind: "REFUND", referenceExternalTransactionId: betExternal }),
    });
    const betResult = await fetch(`${base}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${betExternal}` },
      body: JSON.stringify(bet(wallet, betExternal, "10.00")),
    });

    expect(((await refund.json()) as WagerOutcome).status).toBe(WagerTransactionStatus.PendingReference);
    expect(((await betResult.json()) as WagerOutcome).status).toBe(WagerTransactionStatus.Processed);
  });
});
