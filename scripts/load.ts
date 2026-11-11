import { cpus, platform, release, totalmem } from "node:os";

import { Decimal } from "decimal.js";
import type { MikroORM } from "@mikro-orm/postgresql";

import { loadConfig } from "../src/config";
import { createQueues, sqsClient, type QueueNames } from "../src/messaging/sqs";
import { createOrm } from "../src/persistence/orm";

const INSTANCES = 3;
const BASE_PORT = 3411;
const CONCURRENCY = 16;
const HOT_CONCURRENCY = 8;
const SPREAD_WALLETS = 16;
const SPREAD_BETS = 240;
const HOT_BETS = 80;
const REPLAYS = 48;
const TIGHT_BETS = 12;
const SPREAD_OPENING = "5000.00";
const HOT_OPENING = "5000.00";
const REPLAY_OPENING = "100.00";
const REPLAY_BET = "10.00";
const TIGHT_OPENING = "100.00";
const SMALL_BET = "1.00";
const TIGHT_BET = "80.00";
const DRAIN_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 45_000;
const DEFAULT_DATABASE_URL = "postgresql://wagerflow:wagerflow@localhost:5432/wagerflow_load";

const root = `${import.meta.dir}/..`;

type WalletRole = "spread" | "hot" | "replay" | "tight";

type WalletRef = {
  id: string;
  playerId: string;
  role: WalletRole;
  initial: string;
  attempted: Decimal;
};

type Sample = {
  ms: number;
  http: number;
  status?: string;
  replay: boolean;
  transport: boolean;
};

type Totals = {
  attempts: number;
  transport: number;
  http503: number;
  http5xx: number;
  http409: number;
  http4xx: number;
  processed: number;
  rejected: number;
  replay: number;
  pending: number;
  other: number;
  latencies: number[];
};

type PhaseResult = {
  name: string;
  elapsedMs: number;
  concurrency: number;
  totals: Totals;
};

type Child = {
  port: number;
  proc: Bun.Subprocess;
  logs: string[];
};

type OutboxSnapshot = {
  unpublished: number;
  published: number;
  lagSeconds: number;
};

const children: Child[] = [];
let baseCursor = 0;

async function main(): Promise<void> {
  process.once("SIGINT", () => {
    stopChildren();
    process.exit(130);
  });

  const startedAt = new Date();
  const databaseUrl = process.env.LOAD_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  if (process.env.LOAD_DATABASE_URL === undefined) await ensureLoadDatabase();

  const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
  const run = Bun.randomUUIDv7().replaceAll("-", "").slice(0, 12);
  const orm = await createOrm(databaseUrl);
  let watch: { stop: () => Promise<number> } | undefined;

  try {
    await orm.migrator.up();
    const config = loadConfig({ ...process.env, DATABASE_URL: databaseUrl, SQS_ENDPOINT: endpoint });
    const queues = await createQueues(sqsClient(config), {
      prefix: `load${run}-`,
      visibilityTimeout: 30,
      maxReceiveCount: 5,
    });
    const ports = Array.from({ length: INSTANCES }, (_, index) => BASE_PORT + index);
    const bases = ports.map((port) => `http://127.0.0.1:${port}`);
    for (const port of ports) children.push(spawnInstance(port, databaseUrl, endpoint, queues));
    await Promise.all(ports.map((port) => waitReady(port)));
    for (const child of children) assertAlive(child);

    const openOn = bases[0]!;
    const spread = await Promise.all(
      Array.from({ length: SPREAD_WALLETS }, () => openWallet(openOn, SPREAD_OPENING, "spread")),
    );
    const hot = await openWallet(openOn, HOT_OPENING, "hot");
    const replayWallet = await openWallet(openOn, REPLAY_OPENING, "replay");
    const tight = await openWallet(openOn, TIGHT_OPENING, "tight");
    const wallets = [...spread, hot, replayWallet, tight];

    const walletIds = wallets.map((wallet) => wallet.id);
    watch = watchLag(orm, walletIds);
    const phases: PhaseResult[] = [];
    phases.push(await runPhase("spread", CONCURRENCY, spreadJobs(spread, run, bases)));
    phases.push(await runPhase("hot-wallet", HOT_CONCURRENCY, hotJobs(hot, run, bases)));

    const replayKey = `${run}-replay`;
    replayWallet.attempted = replayWallet.attempted.plus(REPLAY_BET);
    phases.push(
      await runPhase(
        "replay",
        CONCURRENCY,
        Array.from({ length: REPLAYS + 1 }, () => () => submit(nextBase(bases), replayWallet, replayKey, REPLAY_BET)),
      ),
    );

    phases.push(await runPhase("tight-balance", TIGHT_BETS, tightJobs(tight, run, bases)));

    const atStop = await outboxSnapshot(orm, walletIds);
    const peakDuringClient = await watch.stop();
    watch = undefined;
    const drainStarted = performance.now();
    let drained = atStop;
    while (drained.unpublished > 0 && performance.now() - drainStarted < DRAIN_TIMEOUT_MS) {
      await Bun.sleep(200);
      drained = await outboxSnapshot(orm, walletIds);
    }

    const drainMs = performance.now() - drainStarted;
    await Bun.sleep(700);
    const metrics = parseMetrics(await scrape(bases));
    const problems = await checkInvariants(orm, wallets, drained);

    const report = renderReport({
      startedAt,
      databaseUrl,
      endpoint,
      queuePrefix: `load${run}-`,
      ports,
      phases,
      atStop,
      drained,
      drainMs,
      peakLagSeconds: peakDuringClient,
      metrics,
      problems,
    });
    console.log(report);
    if (problems.length > 0) process.exitCode = 1;
  } finally {
    await watch?.stop();
    stopChildren();
    await Promise.all(children.map((child) => child.proc.exited));
    await orm.close(true);
  }
}

function spreadJobs(wallets: WalletRef[], run: string, bases: string[]): Array<() => Promise<Sample>> {
  return Array.from({ length: SPREAD_BETS }, (_, index) => {
    const wallet = wallets[index % wallets.length]!;
    wallet.attempted = wallet.attempted.plus(SMALL_BET);
    const externalId = `${run}-s-${index}`;
    return () => submit(nextBase(bases), wallet, externalId, SMALL_BET);
  });
}

function hotJobs(wallet: WalletRef, run: string, bases: string[]): Array<() => Promise<Sample>> {
  return Array.from({ length: HOT_BETS }, (_, index) => {
    wallet.attempted = wallet.attempted.plus(SMALL_BET);
    const externalId = `${run}-h-${index}`;
    return () => submit(nextBase(bases), wallet, externalId, SMALL_BET);
  });
}

function tightJobs(wallet: WalletRef, run: string, bases: string[]): Array<() => Promise<Sample>> {
  return Array.from({ length: TIGHT_BETS }, (_, index) => {
    wallet.attempted = wallet.attempted.plus(TIGHT_BET);
    const externalId = `${run}-t-${index}`;
    return () => submit(nextBase(bases), wallet, externalId, TIGHT_BET);
  });
}

function nextBase(bases: string[]): string {
  const base = bases[baseCursor % bases.length]!;
  baseCursor += 1;
  return base;
}

async function runPhase(name: string, concurrency: number, jobs: Array<() => Promise<Sample>>): Promise<PhaseResult> {
  const totals = emptyTotals();
  const started = performance.now();
  await runPool(
    jobs.map((job) => async () => addSample(totals, await job())),
    concurrency,
  );

  return { name, elapsedMs: performance.now() - started, concurrency, totals };
}

async function runPool(jobs: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      await jobs[index]!();
    }
  });
  await Promise.all(workers);
}

async function submit(base: string, wallet: WalletRef, externalId: string, amount: string): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await fetch(`${base}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `load:${externalId}` },
      body: JSON.stringify({
        providerId: "load",
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "load-round",
        gameId: "load-probe",
        kind: "BET",
        money: { amount, currency: "BRL" },
      }),
    });
    const sample: Sample = { ms: performance.now() - started, http: response.status, replay: false, transport: false };
    const body = (await response.json().catch(() => null)) as { status?: string; idempotentReplay?: boolean } | null;
    if (body) {
      sample.status = body.status;
      sample.replay = body.idempotentReplay === true;
    }

    return sample;
  } catch {
    return { ms: performance.now() - started, http: 0, replay: false, transport: true };
  }
}

async function openWallet(base: string, amount: string, role: WalletRole): Promise<WalletRef> {
  const response = await fetch(`${base}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: "BRL" } }),
  });
  if (response.status !== 201) throw new Error(`open wallet failed: ${response.status} ${await response.text()}`);

  const body = (await response.json()) as { id: string; playerId: string };
  return { id: body.id, playerId: body.playerId, role, initial: amount, attempted: new Decimal(0) };
}

function emptyTotals(): Totals {
  return {
    attempts: 0,
    transport: 0,
    http503: 0,
    http5xx: 0,
    http409: 0,
    http4xx: 0,
    processed: 0,
    rejected: 0,
    replay: 0,
    pending: 0,
    other: 0,
    latencies: [],
  };
}

function addSample(totals: Totals, sample: Sample): void {
  totals.attempts += 1;
  totals.latencies.push(sample.ms);
  if (sample.transport) {
    totals.transport += 1;
    return;
  }

  if (sample.http === 503) totals.http503 += 1;
  if (sample.http >= 500) {
    totals.http5xx += 1;
    return;
  }

  if (sample.http === 409) {
    totals.http409 += 1;
    return;
  }

  if (sample.http >= 400) {
    totals.http4xx += 1;
    return;
  }

  if (sample.replay) totals.replay += 1;
  else if (sample.status === "PROCESSED") totals.processed += 1;
  else if (sample.status === "REJECTED") totals.rejected += 1;
  else if (sample.status === "PENDING_REFERENCE") totals.pending += 1;
  else totals.other += 1;
}

async function checkInvariants(orm: MikroORM, wallets: WalletRef[], drained: OutboxSnapshot): Promise<string[]> {
  const problems: string[] = [];
  const ids = wallets.map((wallet) => wallet.id);
  const balances = await sql<{ id: string; stored: string; folded: string }>(
    orm,
    `select w.id::text as id, w.balance_amount::text as stored,
       coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19, 2)::text as folded
     from wallets w
     left join wallet_ledger_entries l on l.wallet_id = w.id
     where w.id in (${inClause(ids.length)})
     group by w.id, w.balance_amount`,
    ids,
  );
  const debits = await sql<{ wallet_id: string; processed: number | string; debited: string }>(
    orm,
    `select wallet_id, count(*)::int as processed, coalesce(sum(amount), 0)::numeric(19, 2)::text as debited
     from wager_transactions
     where kind = 'BET' and status = 'PROCESSED' and wallet_id in (${inClause(ids.length)})
     group by wallet_id`,
    ids,
  );
  const byBalance = new Map(balances.map((row) => [row.id, row]));
  const byDebit = new Map(debits.map((row) => [row.wallet_id, { processed: Number(row.processed), debited: row.debited }]));

  let spreadProcessed = 0;
  let hotProcessed = 0;
  for (const wallet of wallets) {
    const balance = byBalance.get(wallet.id);
    const debit = byDebit.get(wallet.id) ?? { processed: 0, debited: "0.00" };
    if (!balance) {
      problems.push(`${wallet.role} wallet ${wallet.id} is missing`);
      continue;
    }

    if (!sameMoney(balance.stored, balance.folded)) problems.push(`${wallet.role} ${wallet.id} stored ${balance.stored} != ledger ${balance.folded}`);

    const expected = new Decimal(wallet.initial).minus(debit.debited).toFixed(2);
    if (!sameMoney(balance.stored, expected)) {
      problems.push(`${wallet.role} ${wallet.id} stored ${balance.stored} != opening ${wallet.initial} - debits ${debit.debited}`);
    }

    if (new Decimal(debit.debited).greaterThan(wallet.attempted)) {
      problems.push(`${wallet.role} ${wallet.id} debited ${debit.debited} above attempted ${wallet.attempted.toFixed(2)}`);
    }

    if (wallet.role === "spread") spreadProcessed += debit.processed;
    if (wallet.role === "hot") hotProcessed += debit.processed;
    if (wallet.role === "replay" && debit.processed !== 1) problems.push(`replay wallet processed ${debit.processed} bets`);
    if (wallet.role === "tight" && debit.processed !== 1) problems.push(`tight wallet processed ${debit.processed} bets`);
    if (wallet.role === "tight" && !sameMoney(balance.stored, "20.00")) problems.push(`tight wallet balance ${balance.stored}`);
  }

  if (spreadProcessed === 0) problems.push("spread phase applied no bets");
  if (hotProcessed === 0) problems.push("hot-wallet phase applied no bets");
  if (drained.unpublished > 0) problems.push(`outbox still has ${drained.unpublished} unpublished rows after ${DRAIN_TIMEOUT_MS}ms`);
  if (drained.published === 0) problems.push("outbox published no rows for this run");

  return problems;
}

async function outboxSnapshot(orm: MikroORM, walletIds: string[]): Promise<OutboxSnapshot> {
  const rows = await sql<{ unpublished: number | string; published: number | string; lag_seconds: number | string | null }>(
    orm,
    `select count(*) filter (where published_at is null)::int as unpublished,
       count(*) filter (where published_at is not null)::int as published,
       extract(epoch from (clock_timestamp() - min(occurred_at) filter (where published_at is null))) as lag_seconds
     from outbox_messages
     where aggregate_id in (${inClause(walletIds.length)})`,
    walletIds,
  );
  const row = rows[0];
  return {
    unpublished: Number(row?.unpublished ?? 0),
    published: Number(row?.published ?? 0),
    lagSeconds: Number(row?.lag_seconds ?? 0),
  };
}

function watchLag(orm: MikroORM, walletIds: string[]): { stop: () => Promise<number> } {
  let stopped = false;
  let peak = 0;
  const loop = (async () => {
    while (!stopped) {
      const snapshot = await outboxSnapshot(orm, walletIds);
      peak = Math.max(peak, snapshot.lagSeconds);
      await Bun.sleep(250);
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await loop;
      return peak;
    },
  };
}

async function sql<T>(orm: MikroORM, query: string, params: unknown[]): Promise<T[]> {
  return (await orm.em.fork().execute(query, params)) as T[];
}

function inClause(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function sameMoney(left: string, right: string): boolean {
  return new Decimal(left).equals(right);
}

type MetricSnapshot = {
  lockConflicts: number;
  retries: number;
  dlqDepth: number;
  gaugeLag: number;
};

function parseMetrics(text: string): MetricSnapshot {
  return {
    lockConflicts: sum(metricValues(text, "wagerflow_lock_conflicts_total")),
    retries: sum(metricValues(text, "wagerflow_retries_total")),
    dlqDepth: Math.max(0, ...metricValues(text, "wagerflow_dlq_depth"), 0),
    gaugeLag: Math.max(0, ...metricValues(text, "wagerflow_outbox_lag_seconds"), 0),
  };
}

function metricValues(text: string, name: string): number[] {
  const values: number[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue;
    const marker = line[name.length];
    if (marker !== "{" && marker !== " ") continue;

    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (Number.isFinite(value)) values.push(value);
  }

  return values;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function scrape(bases: string[]): Promise<string> {
  const texts = await Promise.all(
    bases.map(async (base) => {
      try {
        const response = await fetch(`${base}/metrics`);
        return response.ok ? await response.text() : "";
      } catch {
        return "";
      }
    }),
  );

  return texts.join("\n");
}

function renderReport(input: {
  startedAt: Date;
  databaseUrl: string;
  endpoint: string;
  queuePrefix: string;
  ports: number[];
  phases: PhaseResult[];
  atStop: OutboxSnapshot;
  drained: OutboxSnapshot;
  drainMs: number;
  peakLagSeconds: number;
  metrics: MetricSnapshot;
  problems: string[];
}): string {
  const combined = emptyTotals();
  for (const phase of input.phases) mergeTotals(combined, phase.totals);

  const lines = [
    "Wagerflow load experiment",
    "",
    `started: ${input.startedAt.toISOString()}`,
    `host: ${platform()} ${release()}, ${cpus().length} cpus, ${(totalmem() / 1024 ** 3).toFixed(1)} GiB, bun ${Bun.version}`,
    `database: ${publicUrl(input.databaseUrl)}`,
    `sqs: ${input.endpoint}, queue prefix ${input.queuePrefix}`,
    `instances: ${input.ports.length} on ports ${input.ports.join(", ")} (HTTP, publisher, consumer, pending-reference worker)`,
    "workload: unique bets across many wallets, unique bets on one hot wallet, replays of one key, parallel bets that exceed a 100.00 balance",
    "phases run one after another. sequential is their sum, not mixed load. replay is the same key; it is not the debit path.",
    "latency: client round trip in ms. errors: transport and HTTP 5xx, including 503 lock timeouts. rejected is a business result.",
    "there is no RPS target. rows stay in wagerflow_load.",
    "",
    "phase            conc    n    sec    rps    p50    p95    p99  processed  replay  rejected  503  fail  409",
  ];

  for (const phase of input.phases) lines.push(formatPhase(phase));
  lines.push(
    formatPhase({
      name: "sequential",
      elapsedMs: input.phases.reduce((total, phase) => total + phase.elapsedMs, 0),
      concurrency: 0,
      totals: combined,
    }),
  );
  lines.push("");
  lines.push(
    `errors: ${combined.transport + combined.http5xx}/${combined.attempts} (${percent(combined.transport + combined.http5xx, combined.attempts)})`,
  );
  lines.push(`concurrency: http 503 ${combined.http503}, lock_conflicts metric ${input.metrics.lockConflicts}, business rejected ${combined.rejected}`);
  lines.push(`idempotency replays: ${combined.replay}; payload conflicts (409): ${combined.http409}`);
  lines.push(`leftovers: pending ${combined.pending}, http 4xx ${combined.http4xx}, unclassified ${combined.other}`);
  lines.push(
    `outbox while sending: peak unpublished age ${input.peakLagSeconds.toFixed(3)}s; at client stop ${input.atStop.unpublished} unpublished, oldest ${input.atStop.lagSeconds.toFixed(3)}s`,
  );
  lines.push(
    `outbox after commit: publishers drained already-committed rows in ${input.drainMs.toFixed(0)}ms to ${input.drained.unpublished} unpublished / ${input.drained.published} published`,
  );
  lines.push(
    `metrics after the next publisher tick: outbox gauge ${input.metrics.gaugeLag.toFixed(3)}s, retries ${input.metrics.retries}, dlq depth ${input.metrics.dlqDepth}`,
  );
  lines.push("");
  if (input.problems.length === 0) lines.push("invariants: pass (ledger fold, debits within attempts, one replay debit, one tight-wallet debit, outbox drained)");
  else {
    lines.push("invariants: fail");
    for (const problem of input.problems) lines.push(`- ${problem}`);
  }

  return lines.join("\n");
}

function formatPhase(phase: PhaseResult): string {
  const totals = phase.totals;
  const seconds = phase.elapsedMs / 1000;
  const cells = [
    phase.name.padEnd(16),
    String(phase.concurrency).padStart(4),
    String(totals.attempts).padStart(4),
    seconds.toFixed(2).padStart(6),
    (totals.attempts / seconds).toFixed(1).padStart(6),
    percentile(totals.latencies, 50).padStart(6),
    percentile(totals.latencies, 95).padStart(6),
    percentile(totals.latencies, 99).padStart(6),
    String(totals.processed).padStart(10),
    String(totals.replay).padStart(7),
    String(totals.rejected).padStart(9),
    String(totals.http503).padStart(4),
    String(totals.http5xx - totals.http503 + totals.transport).padStart(5),
    String(totals.http409).padStart(4),
  ];

  return cells.join(" ");
}

function mergeTotals(target: Totals, extra: Totals): void {
  target.attempts += extra.attempts;
  target.transport += extra.transport;
  target.http503 += extra.http503;
  target.http5xx += extra.http5xx;
  target.http409 += extra.http409;
  target.http4xx += extra.http4xx;
  target.processed += extra.processed;
  target.rejected += extra.rejected;
  target.replay += extra.replay;
  target.pending += extra.pending;
  target.other += extra.other;
  target.latencies.push(...extra.latencies);
}

function percentile(samples: number[], p: number): string {
  if (samples.length === 0) return "n/a";

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!.toFixed(0);
}

function percent(part: number, whole: number): string {
  if (whole === 0) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function publicUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

function spawnInstance(port: number, databaseUrl: string, endpoint: string, queues: QueueNames): Child {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  env.PORT = String(port);
  env.DATABASE_URL = databaseUrl;
  env.SQS_ENDPOINT = endpoint;
  env.SQS_WAGER_QUEUE_URL = queues.wagerQueueUrl;
  env.SQS_WAGER_DLQ_URL = queues.wagerDlqUrl;
  env.SQS_EVENTS_QUEUE_URL = queues.eventsQueueUrl;

  const logs: string[] = [];
  const proc = Bun.spawn(["bun", "src/main.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  void collect(proc.stdout, logs);
  void collect(proc.stderr, logs);
  return { port, proc, logs };
}

async function collect(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      if (lines.length > 40) lines.shift();
    }
  }
}

async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const child = children.find((item) => item.port === port);
    if (child && child.proc.exitCode !== null) {
      throw new Error(`instance on port ${port} exited ${child.proc.exitCode}\n${child.logs.join("\n")}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) return;
    } catch {
      // still booting
    }

    await Bun.sleep(200);
  }

  const child = children.find((item) => item.port === port);
  throw new Error(`instance on port ${port} was not ready\n${child?.logs.join("\n") ?? ""}`);
}

function assertAlive(child: Child): void {
  if (child.proc.exitCode !== null) throw new Error(`instance on port ${child.port} exited ${child.proc.exitCode}\n${child.logs.join("\n")}`);
}

function stopChildren(): void {
  for (const child of children) {
    if (child.proc.exitCode === null) child.proc.kill("SIGTERM");
  }
}

async function ensureLoadDatabase(): Promise<void> {
  const proc = Bun.spawn(
    ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "wagerflow", "-d", "postgres", "-c", "create database wagerflow_load"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code === 0 || stderr.toLowerCase().includes("already exists")) return;

  throw new Error(`could not create wagerflow_load (${code}): ${stderr.trim()}`);
}

await main();
