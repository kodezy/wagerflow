import { loadConfig, type Config } from "../../src/config";
import { createQueues, sqsClient, SqsGateway, type QueueNames } from "../../src/messaging/sqs";
import { TEST_DATABASE_URL } from "./database";

export type { QueueNames };

export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? "http://localhost:4566";

export async function testQueues(visibilityTimeout = 5): Promise<{ config: Config; sqs: SqsGateway; queues: QueueNames }> {
  const prefix = `t${Bun.randomUUIDv7().replaceAll("-", "").slice(0, 16)}-`;
  const base = loadConfig({
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    SQS_ENDPOINT,
  });
  const client = sqsClient(base);
  const queues = await createQueues(client, { prefix, visibilityTimeout, maxReceiveCount: 5 });
  const config = testConfig(queues);

  return { config, queues, sqs: new SqsGateway(client, queues) };
}

export function testConfig(queues: QueueNames, overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      SQS_ENDPOINT,
      SQS_WAGER_QUEUE_URL: queues.wagerQueueUrl,
      SQS_WAGER_DLQ_URL: queues.wagerDlqUrl,
      SQS_EVENTS_QUEUE_URL: queues.eventsQueueUrl,
    }),
    workers: { consumer: false, publisher: false, pendingReferences: false },
    ...overrides,
  };
}

export async function drainQueue(sqs: SqsGateway, queueUrl: string, idleMs = 2_000): Promise<void> {
  let idleSince = Date.now();

  while (Date.now() - idleSince < idleMs) {
    const batch = await sqs.receiveFrom(queueUrl, 1);
    if (batch.length === 0) {
      await Bun.sleep(50);
      continue;
    }

    idleSince = Date.now();
    for (const delivery of batch) {
      await sqs.deleteFrom(queueUrl, delivery.receiptHandle);
    }
  }
}

export async function publishOpeningOutbox(sqs: SqsGateway, eventsUrl: string, publish: () => Promise<number>): Promise<void> {
  const published = await publish();
  if (published > 0) await drainQueue(sqs, eventsUrl, Math.max(2_000, published * 1_000));
}

export async function receiveBodies(sqs: SqsGateway, queueUrl: string, count: number, timeoutMs = 20_000): Promise<string[]> {
  const bodies: string[] = [];
  const deadline = Date.now() + timeoutMs;

  while (bodies.length < count && Date.now() < deadline) {
    const batch = await sqs.receiveFrom(queueUrl, 1);
    for (const delivery of batch) {
      bodies.push(delivery.body);
      await sqs.deleteFrom(queueUrl, delivery.receiptHandle);
      if (bodies.length >= count) break;
    }
  }

  return bodies;
}

export function requested(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}, messageId?: string): string {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  const data = {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };

  return JSON.stringify({
    messageId: messageId ?? Bun.randomUUIDv7(),
    type: "WagerTransactionRequested",
    occurredAt: "2026-11-10T12:00:00.000Z",
    data,
  });
}
