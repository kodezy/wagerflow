import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";

import { logLine, Metrics } from "../observability";
import { CLOCK, type Clock } from "../wagering/clock";
import { QueryWagering } from "../wagering/query";
import { parseWagerRequest } from "../wagering/request";
import { TransientStoreError } from "../wagering/store";
import { SubmitWager } from "../wagering/submit";
import { correlationOf, outcomeBody, outcomeStatus, parseJson } from "./reply";

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWager) private readonly submit: SubmitWager,
    @Inject(QueryWagering) private readonly query: QueryWagering,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post("wagering/transactions")
  async submitWager(
    @Body() body: unknown,
    @Headers() headers: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const correlationId = correlationOf(headers);
    const started = this.clock.now();
    const request = parseWagerRequest(parseJson(body), headers["idempotency-key"]);

    try {
      const result = await this.submit.execute({ request, correlationId });
      this.metrics.observeLatency("http", started, this.clock.now());

      if (result.type === "conflict") {
        response.status(409);
        return { code: result.code, transactionId: result.transactionId };
      }

      if (result.type !== "outcome" && result.type !== "inbox-replay") {
        response.status(409);
        return { code: "INBOX_PAYLOAD_CONFLICT" };
      }

      this.metrics.recordOutcome("http", result.outcome);
      logLine("wager.submitted", {
        correlationId,
        transactionId: result.outcome.transactionId,
        walletId: request.walletId,
        providerId: request.providerId,
        status: result.outcome.status,
        failureCode: result.outcome.failureCode,
        idempotentReplay: result.outcome.idempotentReplay,
      });
      response.status(outcomeStatus(result.outcome));
      return outcomeBody(result.outcome);
    } catch (error) {
      if (error instanceof TransientStoreError && error.reason === "lock_timeout") this.metrics.recordLockConflict("http");
      throw error;
    }
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId") transactionId: string, @Res({ passthrough: true }) response: Response): Promise<unknown> {
    const transaction = await this.query.transaction(transactionId);
    if (!transaction) {
      response.status(404);
      return { code: "NOT_FOUND" };
    }

    return transaction;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const transaction = await this.query.transactionByExternal(providerId, externalTransactionId);
    if (!transaction) {
      response.status(404);
      return { code: "NOT_FOUND" };
    }

    return transaction;
  }
}
