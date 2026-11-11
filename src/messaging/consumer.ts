import { logError, logLine, type Metrics } from "../observability";
import type { Clock } from "../wagering/clock";
import { ValidationError } from "../wagering/errors";
import { sha256 } from "../wagering/hash";
import { parseWagerRequest } from "../wagering/request";
import { TransientStoreError } from "../wagering/store";
import { SubmitWager, type SubmitResult } from "../wagering/submit";
import type { SqsDelivery, SqsGateway } from "./sqs";

export const CONSUMER_NAME = "wager-transactions";
const LANES = 5;

export class WagerConsumer {
  private stopping?: AbortController;
  private running?: Promise<void>;
  private inflight: SqsDelivery[] = [];

  constructor(
    private readonly sqs: SqsGateway,
    private readonly submit: SubmitWager,
    private readonly metrics: Metrics,
    private readonly clock: Clock,
    private readonly graceMs: number,
  ) {}

  start(): void {
    if (this.running) return;

    this.stopping = new AbortController();
    this.running = this.run(this.stopping.signal);
  }

  async stop(): Promise<void> {
    this.stopping?.abort();
    await Promise.race([this.running ?? Promise.resolve(), Bun.sleep(this.graceMs)]);

    await Promise.all(
      this.inflight.map((delivery) =>
        this.sqs.release(delivery.receiptHandle).catch((error) => logError({ messageId: delivery.sqsMessageId }, error)),
      ),
    );
    this.inflight = [];
    this.running = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const batch = await this.sqs.receive(signal);
        this.metrics.setDlqDepth(await this.sqs.dlqDepth());
        await runLanes([...groupByWallet(batch).values()], LANES, (group) => this.consumeGroup(group));
      } catch (error) {
        if (signal.aborted) return;
        logError({}, error);
      }
    }
  }

  private async consumeGroup(group: SqsDelivery[]): Promise<void> {
    for (const delivery of group) await this.consume(delivery);
  }

  private async consume(delivery: SqsDelivery): Promise<void> {
    this.inflight.push(delivery);
    const started = this.clock.now();

    try {
      const parsed = parseEnvelope(delivery.body);
      if (!parsed) {
        await this.sqs.sendToDlq(delivery.body, delivery.messageGroupId, delivery.sqsMessageId);
        await this.sqs.delete(delivery.receiptHandle);
        logLine("sqs.dlq", { correlationId: delivery.sqsMessageId, messageId: delivery.sqsMessageId });
        return;
      }

      const result = await this.submit.execute({
        request: parsed.request,
        correlationId: parsed.messageId,
        inbox: { consumerName: CONSUMER_NAME, messageId: parsed.messageId, payloadHash: sha256(delivery.body) },
      });

      this.metrics.observeLatency("sqs", started, this.clock.now());
      this.acknowledge(parsed.messageId, parsed.request.walletId, parsed.request.providerId, result);
      await this.sqs.delete(delivery.receiptHandle);
    } catch (error) {
      if (error instanceof TransientStoreError) {
        this.metrics.recordRetry("sqs");
        if (error.reason === "lock_timeout") this.metrics.recordLockConflict("sqs");
        return;
      }

      logError({ messageId: delivery.sqsMessageId }, error);
    } finally {
      this.inflight = this.inflight.filter((item) => item.receiptHandle !== delivery.receiptHandle);
    }
  }

  private acknowledge(messageId: string, walletId: string, providerId: string, result: SubmitResult): void {
    const fields = { correlationId: messageId, messageId, walletId, providerId };

    if (result.type === "inbox-replay") {
      this.metrics.recordOutcome("sqs", result.outcome, true);
      logLine("sqs.redelivered", { ...fields, transactionId: result.outcome.transactionId, status: result.outcome.status });
      return;
    }

    if (result.type === "inbox-conflict" || result.type === "conflict") {
      logLine("sqs.acknowledged", { ...fields, transactionId: result.type === "conflict" ? result.transactionId : undefined });
      return;
    }

    this.metrics.recordOutcome("sqs", result.outcome);
    logLine("wager.submitted", {
      ...fields,
      transactionId: result.outcome.transactionId,
      status: result.outcome.status,
      failureCode: result.outcome.failureCode,
      idempotentReplay: result.outcome.idempotentReplay,
    });
  }
}

function parseEnvelope(body: string): { messageId: string; request: ReturnType<typeof parseWagerRequest> } | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const envelope = parsed as Record<string, unknown>;
    if (envelope.type !== "WagerTransactionRequested") return undefined;
    if (typeof envelope.messageId !== "string" || !/^[\x20-\x7E]{1,128}$/.test(envelope.messageId)) return undefined;
    if (typeof envelope.data !== "object" || envelope.data === null) return undefined;

    const data = envelope.data as Record<string, unknown>;
    return { messageId: envelope.messageId, request: parseWagerRequest(data, data.idempotencyKey) };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function groupByWallet(batch: SqsDelivery[]): Map<string, SqsDelivery[]> {
  const groups = new Map<string, SqsDelivery[]>();
  for (const delivery of batch) {
    const group = groups.get(delivery.messageGroupId) ?? [];
    group.push(delivery);
    groups.set(delivery.messageGroupId, group);
  }

  return groups;
}

async function runLanes<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) || 0 }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) await work(item);
      }
    }),
  );
}
