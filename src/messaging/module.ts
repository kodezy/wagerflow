import { Inject, Injectable, Module, type OnApplicationBootstrap, type BeforeApplicationShutdown } from "@nestjs/common";

import { CONFIG, type Config } from "../config";
import { Metrics } from "../observability";
import { CLOCK, type Clock } from "../wagering/clock";
import { ResumePending } from "../wagering/resume";
import { WAGERING_STORE, type WageringStore } from "../wagering/store";
import { SubmitWager } from "../wagering/submit";
import { WagerConsumer } from "./consumer";
import { Loop } from "./loop";
import { OutboxPublisher } from "./publisher";
import { SqsGateway } from "./sqs";
import { PendingReferenceWorker } from "./worker";

@Injectable()
export class MessagingRuntime implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly publisherLoop: Loop;
  private readonly workerLoop: Loop;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(WagerConsumer) private readonly consumer: WagerConsumer,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(PendingReferenceWorker) private readonly worker: PendingReferenceWorker,
  ) {
    this.publisherLoop = new Loop(500, async () => {
      await this.publisher.publishDue();
      await this.publisher.measureLag();
    });
    this.workerLoop = new Loop(500, async () => {
      await this.worker.resumeDue();
    });
  }

  onApplicationBootstrap(): void {
    if (this.config.workers.consumer) this.consumer.start();
    if (this.config.workers.publisher) this.publisherLoop.start();
    if (this.config.workers.pendingReferences) this.workerLoop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
    await this.publisherLoop.stop(this.config.shutdownGraceMs);
    await this.workerLoop.stop(this.config.shutdownGraceMs);
  }
}

@Module({
  providers: [
    {
      provide: WagerConsumer,
      useFactory: (sqs: SqsGateway, submit: SubmitWager, metrics: Metrics, clock: Clock, config: Config) =>
        new WagerConsumer(sqs, submit, metrics, clock, config.shutdownGraceMs),
      inject: [SqsGateway, SubmitWager, Metrics, CLOCK, CONFIG],
    },
    {
      provide: OutboxPublisher,
      useFactory: (store: WageringStore, sqs: SqsGateway, metrics: Metrics, clock: Clock, config: Config) =>
        new OutboxPublisher(store, sqs, metrics, clock, config.backoffCapSeconds),
      inject: [WAGERING_STORE, SqsGateway, Metrics, CLOCK, CONFIG],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (store: WageringStore, resume: ResumePending, metrics: Metrics, clock: Clock) =>
        new PendingReferenceWorker(store, resume, metrics, clock),
      inject: [WAGERING_STORE, ResumePending, Metrics, CLOCK],
    },
    MessagingRuntime,
  ],
})
export class MessagingModule {}
