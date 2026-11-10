import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from "@nestjs/common";

import { Public } from "./guard";

export const READINESS_CHECKS = Symbol("ReadinessChecks");

export interface ReadinessCheck {
  name: string;
  ping(): Promise<void>;
}

@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @HttpCode(200)
  async ready(): Promise<{ status: "ok" }> {
    const results = await Promise.allSettled(this.checks.map((check) => withTimeout(check.ping(), 2000, check.name)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) throw new ServiceUnavailableException({ code: "SERVICE_UNAVAILABLE" });

    return { status: "ok" };
  }
}

function withTimeout(work: Promise<void>, ms: number, name: string): Promise<void> {
  return Promise.race([
    work,
    Bun.sleep(ms).then(() => {
      throw new Error(`${name} timed out`);
    }),
  ]);
}
