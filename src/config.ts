import type { ReferencePolicy } from "./wagering/transaction";

export const CONFIG = Symbol("Config");

export interface SqsConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
}

export interface WorkerSwitches {
  consumer: boolean;
  publisher: boolean;
  pendingReferences: boolean;
}

export interface Config {
  port: number;
  databaseUrl: string;
  sqs: SqsConfig;
  referencePolicy: ReferencePolicy;
  backoffCapSeconds: number;
  shutdownGraceMs: number;
  workers: WorkerSwitches;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const endpoint = env.SQS_ENDPOINT ?? "http://localhost:4566";
  const backoffCapSeconds = positiveInteger(env, "BACKOFF_CAP_SECONDS", 60);

  return {
    port: positiveInteger(env, "PORT", 3000),
    databaseUrl: env.DATABASE_URL ?? "postgresql://wagerflow:wagerflow@localhost:5432/wagerflow",
    sqs: {
      endpoint,
      region: env.SQS_REGION ?? "us-east-1",
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
      wagerQueueUrl: env.SQS_WAGER_QUEUE_URL ?? `${endpoint}/000000000000/wager-transactions.fifo`,
      wagerDlqUrl: env.SQS_WAGER_DLQ_URL ?? `${endpoint}/000000000000/wager-transactions-dlq.fifo`,
      eventsQueueUrl: env.SQS_EVENTS_QUEUE_URL ?? `${endpoint}/000000000000/integration-events.fifo`,
    },
    referencePolicy: { maxMisses: positiveInteger(env, "PENDING_REFERENCE_MAX_MISSES", 12), capSeconds: backoffCapSeconds },
    backoffCapSeconds,
    shutdownGraceMs: 20_000,
    workers: { consumer: true, publisher: true, pendingReferences: true },
  };
}

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);

  return parsed;
}
