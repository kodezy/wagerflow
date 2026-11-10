import { Controller, Get, Header, Inject } from "@nestjs/common";

import { Metrics } from "../observability";
import { Public } from "./guard";

@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metricsText(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
