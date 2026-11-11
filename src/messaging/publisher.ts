import { logError, type Metrics } from "../observability";
import type { Clock } from "../wagering/clock";
import type { WageringStore } from "../wagering/store";
import type { SqsGateway } from "./sqs";

export class OutboxPublisher {
  constructor(
    private readonly store: WageringStore,
    private readonly sqs: SqsGateway,
    private readonly metrics: Metrics,
    private readonly clock: Clock,
    private readonly capSeconds: number,
  ) {}

  async publishDue(): Promise<number> {
    const now = this.clock.now();

    return this.store.claimOutbox(now, 20, async (messages) => {
      for (const message of messages) {
        try {
          await this.sqs.publishEvent(message);
          message.markPublished(this.clock.now());
        } catch (error) {
          message.scheduleRetry(this.clock.now(), this.capSeconds);
          this.metrics.recordRetry("outbox");
          logError({ transactionId: message.id }, error);
        }
      }
    });
  }

  async measureLag(): Promise<void> {
    const oldest = await this.store.oldestUnpublishedOutboxAt();
    this.metrics.setOutboxLag(oldest ? Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000) : 0);
  }
}
