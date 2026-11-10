import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { HttpErrorFilter } from "./errors";
import { HealthController } from "./health";
import { MetricsController } from "./metrics";
import { WageringController } from "./wagering";
import { WalletsController } from "./wallets";

@Module({
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class HttpModule {}
