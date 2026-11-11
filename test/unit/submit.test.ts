import { describe, expect, spyOn, test } from "bun:test";

import { ConflictCode, FailureCode } from "../../src/wagering/errors";
import { SubmitWager } from "../../src/wagering/submit";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../src/wagering/transaction";
import { FakeClock } from "../fakes/clock";
import { FakeStore } from "../fakes/store";
import { expectOutcome, openWallet, wagerRequest } from "../helpers/wagering";

async function setup(amount = "100.00") {
  const store = new FakeStore();
  const clock = new FakeClock();
  const wallet = await openWallet(store, clock, { amount });

  return { store, clock, wallet, submit: new SubmitWager(store, clock) };
}

const brl = (amount: string) => ({ amount, currency: "BRL" });

describe("SubmitWager", () => {
  test("BET debits once and enqueues processed and balance events", async () => {
    const { store, wallet, submit } = await setup();
    const outcome = expectOutcome(await submit.execute({ request: wagerRequest(wallet), correlationId: "c" }));

    expect(outcome).toEqual({
      transactionId: expect.any(String),
      status: WagerTransactionStatus.Processed,
      balance: brl("75.00"),
      failureCode: null,
      idempotentReplay: false,
    });
    expect(store.wallets.get(wallet.id)?.version).toBe(2);
    expect(store.ledger).toHaveLength(2);
    expect(store.eventTypes(wallet.id).slice(2)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(store.ledgerFold(wallet.id)).toBe("75.00");
  });

  test("BET above the balance is rejected without ledger", async () => {
    const { store, wallet, submit } = await setup("10.00");
    const outcome = expectOutcome(await submit.execute({ request: wagerRequest(wallet), correlationId: "c" }));

    expect(outcome).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientBalance, balance: brl("10.00") });
    expect(store.ledger).toHaveLength(1);
    expect(store.eventTypes(wallet.id).slice(2)).toEqual(["WagerTransactionRejected"]);
  });

  test("WIN without a reference credits and LOSS records without moving the balance", async () => {
    const { store, wallet, submit } = await setup();
    const win = expectOutcome(await submit.execute({ request: wagerRequest(wallet, { kind: "WIN", money: brl("30.00") }), correlationId: "c" }));
    const loss = expectOutcome(await submit.execute({ request: wagerRequest(wallet, { kind: "LOSS", money: brl("0.00") }), correlationId: "c" }));

    expect(win).toMatchObject({ status: WagerTransactionStatus.Processed, balance: brl("130.00") });
    expect(loss).toMatchObject({ status: WagerTransactionStatus.Processed, balance: brl("130.00") });
    expect(store.wallets.get(wallet.id)?.version).toBe(2);
    expect(store.ledger).toHaveLength(2);
    expect(store.eventTypes(wallet.id).slice(4)).toEqual(["WagerTransactionProcessed"]);
  });

  test("a replay returns the stored result and its original balance", async () => {
    const { store, wallet, submit } = await setup();
    const request = wagerRequest(wallet);
    const first = expectOutcome(await submit.execute({ request, correlationId: "c" }));
    await submit.execute({ request: wagerRequest(wallet), correlationId: "c" });
    const replay = expectOutcome(await submit.execute({ request, correlationId: "c" }));

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual(brl("75.00"));
    expect(store.balanceOf(wallet.id)).toBe("50.00");
  });

  test("the same key with another payload is a conflict and changes nothing", async () => {
    const { store, wallet, submit } = await setup();
    const request = wagerRequest(wallet, { externalTransactionId: "ext-1" });
    const first = expectOutcome(await submit.execute({ request, correlationId: "c" }));
    const changed = wagerRequest(wallet, { externalTransactionId: "ext-1", money: brl("30.00") }, request.idempotencyKey);

    expect(await submit.execute({ request: changed, correlationId: "c" })).toEqual({
      type: "conflict",
      code: ConflictCode.IdempotencyPayloadConflict,
      transactionId: first.transactionId,
    });
    expect(store.wagers.size).toBe(2);
    expect(store.balanceOf(wallet.id)).toBe("75.00");
  });

  test("the same provider transaction id with another key is a conflict", async () => {
    const { wallet, submit } = await setup();
    const first = expectOutcome(await submit.execute({ request: wagerRequest(wallet, { externalTransactionId: "ext-1" }), correlationId: "c" }));

    expect(await submit.execute({ request: wagerRequest(wallet, { externalTransactionId: "ext-1" }, "other-key"), correlationId: "c" })).toEqual({
      type: "conflict",
      code: ConflictCode.DuplicateExternalTransaction,
      transactionId: first.transactionId,
    });
  });

  test("currency, unknown wallet, and another player are stored rejections", async () => {
    const { store, wallet, submit } = await setup();
    const usd = expectOutcome(await submit.execute({ request: wagerRequest(wallet, { money: { amount: "1.00", currency: "USD" } }), correlationId: "c" }));
    const missingWallet = { id: Bun.randomUUIDv7(), playerId: wallet.playerId };
    const missing = expectOutcome(await submit.execute({ request: wagerRequest(missingWallet), correlationId: "c" }));
    const stranger = expectOutcome(await submit.execute({ request: wagerRequest({ id: wallet.id, playerId: "someone-else" }), correlationId: "c" }));

    expect(usd).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.CurrencyMismatch, balance: brl("100.00") });
    expect(missing).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.WalletNotFound, balance: null });
    expect(stranger).toMatchObject({ failureCode: FailureCode.WalletNotFound, balance: null });
    expect(store.eventTypes(missingWallet.id)).toEqual(["WagerTransactionRejected"]);
    expect(store.ledgerFold(wallet.id)).toBe("100.00");
  });

  test("an unreadable wallet stores FAILED without an event and replays it", async () => {
    const { store, wallet, submit } = await setup();
    const request = wagerRequest(wallet);
    store.corruptWallets.add(wallet.id);
    const outboxBefore = store.outbox.size;

    const failed = expectOutcome(await submit.execute({ request, correlationId: "c" }));
    const replay = expectOutcome(await submit.execute({ request, correlationId: "c" }));

    expect(failed).toMatchObject({ status: WagerTransactionStatus.Failed, failureCode: FailureCode.PermanentInfrastructure, balance: null });
    expect(replay).toEqual({ ...failed, idempotentReplay: true });
    expect(store.outbox.size).toBe(outboxBefore);
  });

  test("an event that cannot be serialized stores FAILED and moves nothing", async () => {
    const { store, wallet, submit } = await setup();
    const request = wagerRequest(wallet);
    // The next JSON.stringify call in submit is the outbox serialization.
    const stringify = spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw new TypeError("cyclic");
    });

    try {
      const outcome = expectOutcome(await submit.execute({ request, correlationId: "c" }));

      expect(outcome).toMatchObject({ status: WagerTransactionStatus.Failed, failureCode: FailureCode.PermanentInfrastructure });
      expect(store.balanceOf(wallet.id)).toBe("100.00");
      expect(store.ledger).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
  });

  test("a unique violation re-runs the checks in the same session", async () => {
    const { store, clock, wallet, submit } = await setup();
    const request = wagerRequest(wallet);
    const rival = WagerTransaction.create({
      id: "rival",
      providerId: request.providerId,
      externalTransactionId: "rival-ext",
      idempotencyKey: request.idempotencyKey,
      payloadHash: "rival-hash",
      walletId: "rival-wallet",
      playerId: request.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: WagerTransactionKind.Bet,
      money: request.money,
      createdAt: clock.now(),
    });
    rival.reject(FailureCode.WalletNotFound, undefined, clock.now());
    store.beforeNextSave = () => store.wagers.set(rival.id, rival.toState());

    expect(await submit.execute({ request, correlationId: "c" })).toEqual({
      type: "conflict",
      code: ConflictCode.IdempotencyPayloadConflict,
      transactionId: "rival",
    });
    expect(store.ledgerFold(wallet.id)).toBe("100.00");
  });

  test("the inbox replays the same body and refuses another body", async () => {
    const { store, wallet, submit } = await setup();
    const request = wagerRequest(wallet);
    const inbox = { consumerName: "wager-transactions", messageId: "msg-1", payloadHash: "raw-1" };

    const first = await submit.execute({ request, correlationId: "msg-1", inbox });
    const again = await submit.execute({ request, correlationId: "msg-1", inbox });
    const changed = await submit.execute({ request: wagerRequest(wallet), correlationId: "msg-1", inbox: { ...inbox, payloadHash: "raw-2" } });

    expect(first.type).toBe("outcome");
    expect(again).toMatchObject({ type: "inbox-replay", outcome: { status: WagerTransactionStatus.Processed, idempotentReplay: true } });
    expect(changed).toEqual({ type: "inbox-conflict" });
    expect(store.inbox.get("wager-transactions:msg-1")?.processedAt).toBeDefined();
    expect(store.ledgerFold(wallet.id)).toBe("75.00");
  });

  test("50 concurrent copies debit once", async () => {
    const { store, wallet, submit } = await setup();
    const request = wagerRequest(wallet);
    const outcomes = (await Promise.all(Array.from({ length: 50 }, () => submit.execute({ request, correlationId: "c" })))).map(expectOutcome);

    expect(outcomes.filter((outcome) => !outcome.idempotentReplay)).toHaveLength(1);
    expect(store.balanceOf(wallet.id)).toBe("75.00");
    expect(store.ledgerFold(wallet.id)).toBe("75.00");
  });
});
