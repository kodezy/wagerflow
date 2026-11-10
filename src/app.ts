import "reflect-metadata";

import { ConsoleLogger, Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { CONFIG, type Config } from "./config";
import { HttpModule } from "./http/module";
import { AuthGuard, PROVIDER_IDENTITY, AnonymousProviderIdentity } from "./http/guard";
import { READINESS_CHECKS, type ReadinessCheck } from "./http/health";
import { MessagingModule } from "./messaging/module";
import { SqsGateway, sqsClient } from "./messaging/sqs";
import { Metrics } from "./observability";
import { PersistenceModule } from "./persistence/module";
import { CLOCK, systemClock, type Clock } from "./wagering/clock";
import { OpenWallet } from "./wagering/open";
import { QueryWagering } from "./wagering/query";
import { ReconcileWallet } from "./wagering/reconcile";
import { ResumePending } from "./wagering/resume";
import { WAGERING_STORE, type WageringStore } from "./wagering/store";
import { SubmitWager } from "./wagering/submit";

@Global()
@Module({})
class CoreModule {
  static register(config: Config): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: CLOCK, useValue: systemClock },
        { provide: Metrics, useValue: new Metrics() },
        { provide: SqsGateway, useFactory: (cfg: Config) => new SqsGateway(sqsClient(cfg), cfg.sqs), inject: [CONFIG] },
        { provide: OpenWallet, useFactory: (store: WageringStore, clock: Clock) => new OpenWallet(store, clock), inject: [WAGERING_STORE, CLOCK] },
        {
          provide: SubmitWager,
          useFactory: (store: WageringStore, clock: Clock, cfg: Config) => new SubmitWager(store, clock, cfg.referencePolicy),
          inject: [WAGERING_STORE, CLOCK, CONFIG],
        },
        {
          provide: ResumePending,
          useFactory: (store: WageringStore, clock: Clock, cfg: Config) => new ResumePending(store, clock, cfg.referencePolicy),
          inject: [WAGERING_STORE, CLOCK, CONFIG],
        },
        { provide: QueryWagering, useFactory: (store: WageringStore) => new QueryWagering(store), inject: [WAGERING_STORE] },
        { provide: ReconcileWallet, useFactory: (store: WageringStore) => new ReconcileWallet(store), inject: [WAGERING_STORE] },
        {
          provide: READINESS_CHECKS,
          useFactory: (store: WageringStore, sqs: SqsGateway): ReadinessCheck[] => [
            { name: "postgres", ping: () => store.ping() },
            { name: "sqs", ping: () => sqs.ping() },
          ],
          inject: [WAGERING_STORE, SqsGateway],
        },
      ],
      exports: [
        CONFIG,
        CLOCK,
        Metrics,
        SqsGateway,
        OpenWallet,
        SubmitWager,
        ResumePending,
        QueryWagering,
        ReconcileWallet,
        READINESS_CHECKS,
      ],
    };
  }
}

@Module({})
export class AppModule {
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [PersistenceModule.register(config.databaseUrl), CoreModule.register(config), HttpModule, MessagingModule],
      providers: [
        { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}

export async function createApp(config: Config) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bodyParser: false,
    logger: new ConsoleLogger({ json: true }),
  });

  app.useBodyParser("text", { type: () => true, limit: "64kb" });
  app.enableShutdownHooks();
  return app;
}
