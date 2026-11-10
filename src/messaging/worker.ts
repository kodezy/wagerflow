import { logLine, type Metrics } from "../observability";
import type { Clock } from "../wagering/clock";
import type { ResumePending } from "../wagering/resume";
import type { WageringStore } from "../wagering/store";

export class PendingReferenceWorker {
  constructor(
    private readonly store: WageringStore,
    private readonly resume: ResumePending,
    private readonly metrics: Metrics,
    private readonly clock: Clock,
  ) {}

  async resumeDue(): Promise<void> {
    const due = await this.store.dueReferences(this.clock.now(), 20);

    for (const item of due) {
      const started = this.clock.now();
      const result = await this.resume.execute(item);
      this.metrics.observeLatency("resume", started, this.clock.now());
      if (result.type === "skipped") continue;

      if (result.type === "waiting") {
        this.metrics.recordRetry("pending_reference");
        continue;
      }

      this.metrics.recordOutcome("resume", result.outcome);
      logLine("wager.resumed", {
        correlationId: result.transaction.id,
        transactionId: result.transaction.id,
        walletId: result.transaction.walletId,
        providerId: result.transaction.providerId,
        status: result.outcome.status,
        failureCode: result.outcome.failureCode,
      });
    }
  }
}
