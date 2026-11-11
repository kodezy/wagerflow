import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { loadConfig } from "../../src/config";
import { SqsGateway, sqsClient } from "../../src/messaging/sqs";
import { createOrm } from "../../src/persistence/orm";
import type { WagerOutcome } from "../../src/wagering/apply";
import { FailureCode } from "../../src/wagering/errors";
import { WagerTransactionStatus } from "../../src/wagering/transaction";
import { waitFor } from "../helpers/async";
import { expectLedgersMatch, sql, TEST_DATABASE_URL } from "../helpers/database";
import { requested, TEST_QUEUE_VISIBILITY_SECONDS, testQueues, type QueueNames } from "../helpers/infra";

let orm: MikroORM;
let queues: QueueNames;
let env: Record<string, string>;

beforeAll(async () => {
  const setup = await testQueues();
  queues = setup.queues;
  orm = await createOrm(TEST_DATABASE_URL);
  await orm.migrator.up();
  env = {
    ...process.env as Record<string, string>,
    DATABASE_URL: TEST_DATABASE_URL,
    SQS_ENDPOINT: setup.config.sqs.endpoint,
    SQS_WAGER_QUEUE_URL: queues.wagerQueueUrl,
    SQS_WAGER_DLQ_URL: queues.wagerDlqUrl,
    SQS_EVENTS_QUEUE_URL: queues.eventsQueueUrl,
  };
});

afterAll(async () => {
  await expectLedgersMatch(orm);
  await orm.close();
});

function spawn(port: number): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "src/main.ts"], { env: { ...env, PORT: String(port) }, stdout: "inherit", stderr: "inherit" });
}

async function waitReady(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      return response.ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
}

type WalletView = { balance: { amount: string } };

async function openOn(port: number): Promise<{ id: string; playerId: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: "100.00", currency: "BRL" } }),
  });
  return (await response.json()) as { id: string; playerId: string };
}

describe("instances", () => {
  test("three processes share one wallet without a global lock", async () => {
    const run = Bun.randomUUIDv7().replaceAll("-", "").slice(0, 12);
    const ports = [3101, 3102, 3103];
    const processes = ports.map(spawn);
    try {
      await Promise.all(ports.map(waitReady));
      const wallet = await openOn(ports[0]!);
      const results = await Promise.all(
        ports.map((port, index) => {
          const externalId = `${run}-i${index}`;
          return fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
            method: "POST",
            headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${externalId}` },
            body: JSON.stringify({
              providerId: "provider-a",
              externalTransactionId: externalId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: "round-1",
              gameId: "fortune-chimp",
              kind: "BET",
              money: { amount: "10.00", currency: "BRL" },
            }),
          });
        }),
      );

      expect(results.every((response) => response.ok || response.status === 202)).toBe(true);
      const current = (await (await fetch(`http://127.0.0.1:${ports[0]}/wallets/${wallet.id}`)).json()) as WalletView;
      expect(current.balance.amount).toBe("70.00");
    } finally {
      for (const child of processes) child.kill("SIGTERM");
      await Promise.all(processes.map((child) => child.exited));
    }
  });

  test("two concurrent 80.00 bets across three processes leave 20.00 and one debit", async () => {
    const run = Bun.randomUUIDv7().replaceAll("-", "").slice(0, 12);
    const ports = [3105, 3106, 3107];
    const processes = ports.map(spawn);
    try {
      await Promise.all(ports.map(waitReady));
      const wallet = await openOn(ports[0]!);
      const responses = await Promise.all(
        ["a", "b"].map((id, index) => {
          const externalId = `${run}-${id}`;
          return fetch(`http://127.0.0.1:${ports[index]}/wagering/transactions`, {
            method: "POST",
            headers: { "content-type": "application/json", "Idempotency-Key": `provider-a:${externalId}` },
            body: JSON.stringify({
              providerId: "provider-a",
              externalTransactionId: externalId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: "round-1",
              gameId: "fortune-chimp",
              kind: "BET",
              money: { amount: "80.00", currency: "BRL" },
            }),
          });
        }),
      );

      const bodies = await Promise.all(responses.map(async (response) => (await response.json()) as WagerOutcome));
      const statuses = bodies.map((body) => body.status).sort();
      const rejected = bodies.find((body) => body.status === WagerTransactionStatus.Rejected);
      const current = (await (await fetch(`http://127.0.0.1:${ports[0]}/wallets/${wallet.id}`)).json()) as WalletView;

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
      expect(rejected?.failureCode).toBe(FailureCode.InsufficientBalance);
      expect(current.balance.amount).toBe("20.00");
      expect(await debitCount(wallet.id)).toBe(1);
    } finally {
      for (const child of processes) child.kill("SIGTERM");
      await Promise.all(processes.map((child) => child.exited));
    }
  });

  test("restart keeps a single debit after the wallet was debited", async () => {
    const port = 3104;
    let child = spawn(port);
    try {
      await waitReady(port);
      const wallet = await openOn(port);
      const sqs = new SqsGateway(sqsClient(loadConfig(env)), queues);
      await sqs.sendWager(requested(wallet, { money: { amount: "10.00", currency: "BRL" } }), wallet.id, Bun.randomUUIDv7());
      await waitFor(async () => {
        const current = (await (await fetch(`http://127.0.0.1:${port}/wallets/${wallet.id}`)).json()) as WalletView;
        return current.balance.amount === "90.00" ? true : undefined;
      });
      child.kill("SIGKILL");
      await child.exited;

      child = spawn(port);
      await waitReady(port);
      const earliestPassAt = Date.now() + (TEST_QUEUE_VISIBILITY_SECONDS + 1) * 1_000;
      await waitFor(async () => {
        if (Date.now() < earliestPassAt) return undefined;

        const current = (await (await fetch(`http://127.0.0.1:${port}/wallets/${wallet.id}`)).json()) as WalletView;
        if (current.balance.amount !== "90.00") return undefined;
        return (await debitCount(wallet.id)) === 1 ? true : undefined;
      }, 15_000, "one debit after queue visibility");

      const current = (await (await fetch(`http://127.0.0.1:${port}/wallets/${wallet.id}`)).json()) as WalletView;
      expect(current.balance.amount).toBe("90.00");
      expect(await debitCount(wallet.id)).toBe(1);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  });
});

async function debitCount(walletId: string): Promise<number> {
  const [row] = await sql<{ total: number }>(
    orm,
    "select count(*)::int as total from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
    [walletId],
  );
  return row?.total ?? 0;
}
