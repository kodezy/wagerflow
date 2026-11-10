import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { logLine, Metrics } from "../observability";
import { OpenWallet } from "../wagering/open";
import { QueryWagering, walletView } from "../wagering/query";
import { ReconcileWallet } from "../wagering/reconcile";
import { parseWalletRequest } from "../wagering/request";
import { correlationOf, parseJson } from "./reply";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly open: OpenWallet,
    @Inject(QueryWagering) private readonly query: QueryWagering,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Headers() headers: Record<string, unknown>, @Res({ passthrough: true }) response: Response): Promise<unknown> {
    const correlationId = correlationOf(headers);
    const result = await this.open.execute(parseWalletRequest(parseJson(body)), correlationId);
    if (result.type === "conflict") {
      response.status(409);
      return { code: result.code };
    }

    logLine("wallet.opened", { correlationId, walletId: result.wallet.id, playerId: result.wallet.playerId });
    response.status(201);
    return walletView(result.wallet);
  }

  @Get(":walletId")
  async wallet(@Param("walletId") walletId: string, @Res({ passthrough: true }) response: Response): Promise<unknown> {
    const wallet = await this.query.wallet(walletId);
    if (!wallet) {
      response.status(404);
      return { code: "NOT_FOUND" };
    }

    return wallet;
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: unknown,
    @Query("limit") limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const page = await this.query.ledger(walletId, { cursor, limit });
    if (!page) {
      response.status(404);
      return { code: "NOT_FOUND" };
    }

    return page;
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconciliation(
    @Param("walletId") walletId: string,
    @Headers() headers: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.reconcile.execute(walletId);
    if (!result) {
      response.status(404);
      return { code: "NOT_FOUND" };
    }

    if (!result.consistent) {
      this.metrics.recordReconciliationMismatch();
      logLine("reconciliation.mismatch", { correlationId: correlationOf(headers), walletId, consistent: false });
    }

    return result;
  }
}
