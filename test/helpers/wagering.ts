import type { WagerOutcome } from "../../src/wagering/apply";
import type { Clock } from "../../src/wagering/clock";
import { OpenWallet } from "../../src/wagering/open";
import { parseWagerRequest, parseWalletRequest, type WagerRequest } from "../../src/wagering/request";
import type { SubmitResult } from "../../src/wagering/submit";
import type { WageringStore } from "../../src/wagering/store";
import type { Wallet } from "../../src/wagering/wallet";

export interface WalletOwner {
  id: string;
  playerId: string;
}

export interface WalletOptions {
  amount?: string;
  currency?: string;
  playerId?: string;
}

export async function openWallet(store: WageringStore, clock: Clock, options: WalletOptions = {}): Promise<Wallet> {
  const request = parseWalletRequest({
    playerId: options.playerId ?? Bun.randomUUIDv7(),
    initialBalance: { amount: options.amount ?? "100.00", currency: options.currency ?? "BRL" },
  });
  const result = await new OpenWallet(store, clock).execute(request, "test");

  if (result.type !== "opened") throw new Error("wallet was not opened");
  return result.wallet;
}

export function wagerBody(wallet: WalletOwner, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: "provider-a",
    externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

export function wagerRequest(wallet: WalletOwner, overrides: Record<string, unknown> = {}, idempotencyKey?: string): WagerRequest {
  const body = wagerBody(wallet, overrides);
  return parseWagerRequest(body, idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`);
}

export function expectOutcome(result: SubmitResult): WagerOutcome {
  if (result.type !== "outcome") throw new Error(`expected an outcome, got ${result.type}`);
  return result.outcome;
}
