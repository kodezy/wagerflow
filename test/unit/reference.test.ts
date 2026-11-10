import { describe, expect, test } from "bun:test";

import { FailureCode } from "../../src/wagering/errors";
import { SubmitWager } from "../../src/wagering/submit";
import { WagerTransactionStatus } from "../../src/wagering/transaction";
import { FakeClock } from "../fakes/clock";
import { FakeStore } from "../fakes/store";
import { expectOutcome, openWallet, wagerRequest, type WalletOwner } from "../helpers/wagering";

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function setup(amount = "100.00") {
  const store = new FakeStore();
  const clock = new FakeClock();
  const wallet = await openWallet(store, clock, { amount, playerId: "player-1" });
  const submit = new SubmitWager(store, clock);
  const send = async (owner: WalletOwner, fields: Record<string, unknown>) =>
    expectOutcome(await submit.execute({ request: wagerRequest(owner, fields), correlationId: "c" }));

  return { store, clock, wallet, send };
}

describe("reversals", () => {
  test("REFUND credits a processed BET once, and any second reversal is rejected", async () => {
    const { store, wallet, send } = await setup();
    const bet = await send(wallet, { externalTransactionId: "bet-1" });
    const refund = await send(wallet, { kind: "REFUND", externalTransactionId: "refund-1", referenceExternalTransactionId: "bet-1" });
    const second = await send(wallet, { kind: "REFUND", externalTransactionId: "refund-2", referenceExternalTransactionId: "bet-1" });
    const rollback = await send(wallet, { kind: "ROLLBACK", externalTransactionId: "rollback-1", referenceExternalTransactionId: "bet-1" });

    expect(refund).toMatchObject({ status: WagerTransactionStatus.Processed, balance: brl("100.00") });
    expect(store.wagers.get(refund.transactionId)?.referenceTransactionId).toBe(bet.transactionId);
    expect(second).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
    expect(rollback).toMatchObject({ failureCode: FailureCode.ReferenceAlreadyReversed, balance: brl("100.00") });
    expect(store.ledgerFold(wallet.id)).toBe("100.00");
  });

  test("ROLLBACK inverts the referenced entry", async () => {
    const { store, wallet, send } = await setup();
    await send(wallet, { externalTransactionId: "bet-1" });
    await send(wallet, { kind: "WIN", externalTransactionId: "win-1", money: brl("40.00") });
    const undoBet = await send(wallet, { kind: "ROLLBACK", externalTransactionId: "rb-1", referenceExternalTransactionId: "bet-1" });
    const undoWin = await send(wallet, { kind: "ROLLBACK", externalTransactionId: "rb-2", referenceExternalTransactionId: "win-1", money: brl("40.00") });

    expect(undoBet.balance).toEqual(brl("140.00"));
    expect(undoWin.balance).toEqual(brl("100.00"));
    expect(store.ledgerFold(wallet.id)).toBe("100.00");
  });

  test("a reversal that would go negative has its own code and stays stored", async () => {
    const { store, wallet, send } = await setup();
    await send(wallet, { kind: "WIN", externalTransactionId: "win-1", money: brl("50.00") });
    await send(wallet, { externalTransactionId: "bet-1", money: brl("150.00") });
    const rollback = await send(wallet, { kind: "ROLLBACK", externalTransactionId: "rb-1", referenceExternalTransactionId: "win-1", money: brl("50.00") });

    expect(rollback).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReversalInsufficientBalance, balance: brl("0.00") });
    expect(store.wagers.get(rollback.transactionId)?.status).toBe(WagerTransactionStatus.Rejected);
    expect(store.eventTypes(wallet.id).at(-1)).toBe("WagerTransactionRejected");
    expect(store.ledgerFold(wallet.id)).toBe("0.00");
  });

  test("kind, scope, amount, status, and currency checks", async () => {
    const { store, clock, wallet, send } = await setup();
    const dollars = await openWallet(store, clock, { currency: "USD", playerId: "player-1" });
    await send(wallet, { externalTransactionId: "bet-1" });
    await send(wallet, { kind: "WIN", externalTransactionId: "win-1" });
    await send(wallet, { kind: "LOSS", externalTransactionId: "loss-1" });
    await send(wallet, { externalTransactionId: "bet-big", money: brl("500.00") });
    await send(dollars, { externalTransactionId: "usd-bet", money: { amount: "25.00", currency: "USD" } });

    const refundWin = await send(wallet, { kind: "REFUND", externalTransactionId: "r-1", referenceExternalTransactionId: "win-1" });
    const rollbackLoss = await send(wallet, { kind: "ROLLBACK", externalTransactionId: "r-2", referenceExternalTransactionId: "loss-1" });
    const otherRound = await send(wallet, { kind: "REFUND", externalTransactionId: "r-3", referenceExternalTransactionId: "bet-1", roundId: "round-2" });
    const partial = await send(wallet, { kind: "REFUND", externalTransactionId: "r-4", referenceExternalTransactionId: "bet-1", money: brl("10.00") });
    const rejectedTarget = await send(wallet, { kind: "REFUND", externalTransactionId: "r-5", referenceExternalTransactionId: "bet-big", money: brl("500.00") });
    const otherCurrency = await send(wallet, { kind: "REFUND", externalTransactionId: "r-6", referenceExternalTransactionId: "usd-bet" });

    expect(refundWin.failureCode).toBe(FailureCode.ReferenceKindMismatch);
    expect(rollbackLoss.failureCode).toBe(FailureCode.ReferenceKindMismatch);
    expect(otherRound.failureCode).toBe(FailureCode.ReferenceScopeMismatch);
    expect(partial.failureCode).toBe(FailureCode.AmountMismatch);
    expect(rejectedTarget.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(otherCurrency.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(store.ledgerFold(wallet.id)).toBe(store.balanceOf(wallet.id) as string);
  });

  test("WIN with a reference credits any amount against the round's BET", async () => {
    const { store, wallet, send } = await setup();
    const bet = await send(wallet, { externalTransactionId: "bet-1" });
    const win = await send(wallet, { kind: "WIN", externalTransactionId: "win-1", referenceExternalTransactionId: "bet-1", money: brl("300.00") });

    expect(win).toMatchObject({ status: WagerTransactionStatus.Processed, balance: brl("375.00") });
    expect(store.wagers.get(win.transactionId)?.referenceTransactionId).toBe(bet.transactionId);
  });

  test("a missing or still-pending reference waits as PENDING_REFERENCE", async () => {
    const { store, clock, wallet, send } = await setup();
    const refund = await send(wallet, { kind: "REFUND", externalTransactionId: "refund-1", referenceExternalTransactionId: "later" });
    const rollback = await send(wallet, { kind: "ROLLBACK", externalTransactionId: "rb-1", referenceExternalTransactionId: "refund-1" });
    const stored = store.wagers.get(refund.transactionId);

    expect(refund).toMatchObject({ status: WagerTransactionStatus.PendingReference, balance: brl("100.00"), failureCode: null });
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    expect(stored?.referenceAttempts).toBe(1);
    expect(stored?.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 1000));
    expect(store.eventTypes(wallet.id).slice(2)).toEqual(["WagerTransactionPendingReference", "WagerTransactionPendingReference"]);
    expect(store.ledger).toHaveLength(1);
  });
});
