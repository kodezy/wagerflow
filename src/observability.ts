import { Registry, Counter, Gauge, Histogram } from "prom-client";

import type { WagerOutcome } from "./wagering/apply";

export type Edge = "http" | "sqs";
export type OutcomeSource = Edge | "resume";
export type RetrySource = "sqs" | "outbox" | "pending_reference";

export class Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagerflow_transactions_total",
    help: "Wager rows inserted or moved to a new status",
    labelNames: ["status"],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wagerflow_duplicates_total",
    help: "Idempotent HTTP replays and same-hash inbox hits",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wagerflow_retries_total",
    help: "Transient SQS leaves, outbox reschedules, and pending-reference misses",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "wagerflow_lock_conflicts_total",
    help: "Wallet lock timeouts",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly latency = new Histogram({
    name: "wagerflow_processing_duration_seconds",
    help: "Submit, consume, and resume latency",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly dlq = new Gauge({
    name: "wagerflow_dlq_depth",
    help: "Approximate messages on the wager DLQ",
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: "wagerflow_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox row",
    registers: [this.registry],
  });

  private readonly mismatches = new Counter({
    name: "wagerflow_reconciliation_mismatches_total",
    help: "Reconciliations whose stored balance differs from the ledger fold",
    registers: [this.registry],
  });

  recordOutcome(source: OutcomeSource, outcome: WagerOutcome, inboxReplay = false): void {
    if (inboxReplay) {
      this.duplicates.inc({ source: "sqs" });
      return;
    }

    if (outcome.idempotentReplay) {
      this.duplicates.inc({ source });
      return;
    }

    this.transactions.inc({ status: outcome.status });
  }

  recordRetry(source: RetrySource): void {
    this.retries.inc({ source });
  }

  recordLockConflict(source: Edge): void {
    this.lockConflicts.inc({ source });
  }

  observeLatency(source: OutcomeSource, started: Date, now: Date): void {
    this.latency.observe({ source }, Math.max(0, (now.getTime() - started.getTime()) / 1000));
  }

  setDlqDepth(depth: number): void {
    this.dlq.set(depth);
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  recordReconciliationMismatch(): void {
    this.mismatches.inc();
  }
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logLine(msg: string, fields: LogFields): void {
  const line: Record<string, unknown> = { msg };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value;
  }

  console.log(JSON.stringify(line));
}

export function logError(fields: LogFields, error: unknown): void {
  const failure = error instanceof Error ? error : new Error("unknown");
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;

  logLine("error", {
    ...fields,
    errorClass: failure.name,
    sqlState: typeof code === "string" ? code : undefined,
  });
}
