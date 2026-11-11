import { describe, expect, test } from "bun:test";

import { FailureCode } from "../../src/wagering/errors";
import { ResumePending } from "../../src/wagering/resume";
import { SubmitWager } from "../../src/wagering/submit";
import { WagerTransactionStatus } from "../../src/wagering/transaction";
import { FakeClock } from "../fakes/clock";
import { FakeStore } from "../fakes/store";
import { expectOutcome, openWallet, wagerRequest } from "../helpers/wagering";

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function setup() {
  const store = new FakeStore();
  const clock = new FakeClock();
  const wallet = await openWallet(store, clock);
  const submit = new SubmitWager(store, clock);
  const send = async (fields: Record<string, unknown>) => expectOutcome(await submit.execute({ request: wagerRequest(wallet, fields), correlationId: "c" }));

  return { store, clock, wallet, submit, send, resume: new ResumePending(store, clock) };
}

describe("ResumePending", () => {
  test("resolves the waiting row once its reference arrives", async () => {
    const { store, clock, wallet, submit, resume } = await setup();
    const refundRequest = wagerRequest(wallet, { kind: "REFUND", externalTransactionId: "refund-1", referenceExternalTransactionId: "bet-1" });
    const pending = expectOutcome(await submit.execute({ request: refundRequest, correlationId: "c" }));
    await submit.execute({ request: wagerRequest(wallet, { externalTransactionId: "bet-1" }), correlationId: "c" });

    clock.advance(1000);
    const [due] = await store.dueReferences(clock.now(), 10);
    const result = await resume.execute(due!);
    const replay = expectOutcome(await submit.execute({ request: refundRequest, correlationId: "c" }));
    const resumedEvents = [...store.outbox.values()].filter((message) => message.payload.correlationId === pending.transactionId);

    expect(result).toMatchObject({ type: "decided", outcome: { status: WagerTransactionStatus.Processed, balance: brl("100.00") } });
    expect(replay).toMatchObject({ status: WagerTransactionStatus.Processed, balance: brl("100.00"), idempotentReplay: true });
    expect(resumedEvents.map((message) => message.eventType)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(store.ledgerFold(wallet.id)).toBe("100.00");
  });

  test("skips a row that is not due or no longer pending", async () => {
    const { store, clock, wallet, send, resume } = await setup();
    const pending = await send({ kind: "REFUND", referenceExternalTransactionId: "missing" });
    const due = { transactionId: pending.transactionId, walletId: wallet.id };

    expect(await store.dueReferences(clock.now(), 10)).toEqual([]);
    expect(await resume.execute(due)).toEqual({ type: "skipped" });

    clock.advance(1000);
    expect((await resume.execute(due)).type).toBe("waiting");
    expect(await resume.execute(due)).toEqual({ type: "skipped" });
  });

  test("the 12th miss rejects with REFERENCE_NOT_FOUND after 363 seconds", async () => {
    const { store, clock, wallet, send, resume } = await setup();
    const started = clock.now().getTime();
    const pending = await send({ kind: "ROLLBACK", referenceExternalTransactionId: "never" });
    const due = { transactionId: pending.transactionId, walletId: wallet.id };
    let result = await resume.execute(due);

    while (result.type !== "decided") {
      const next = store.wagers.get(pending.transactionId)?.nextAttemptAt as Date;
      clock.advance(next.getTime() - clock.now().getTime());
      result = await resume.execute(due);
    }

    expect(result.outcome).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReferenceNotFound, balance: brl("100.00") });
    expect(store.wagers.get(pending.transactionId)?.referenceAttempts).toBe(12);
    expect((clock.now().getTime() - started) / 1000).toBe(363);
    expect(store.eventTypes(wallet.id).at(-1)).toBe("WagerTransactionRejected");
  });

  test("an arrived reference that does not match rejects on that attempt", async () => {
    const { clock, wallet, send, resume } = await setup();
    const pending = await send({ kind: "REFUND", externalTransactionId: "refund-1", referenceExternalTransactionId: "bet-1", money: brl("10.00") });
    await send({ externalTransactionId: "bet-1" });

    clock.advance(1000);
    const result = await resume.execute({ transactionId: pending.transactionId, walletId: wallet.id });

    expect(result).toMatchObject({ type: "decided", outcome: { failureCode: FailureCode.AmountMismatch, balance: brl("75.00") } });
  });

  test("an unreadable wallet fails the pending row", async () => {
    const { store, clock, wallet, send, resume } = await setup();
    const pending = await send({ kind: "REFUND", referenceExternalTransactionId: "missing" });
    store.corruptWallets.add(wallet.id);

    clock.advance(1000);

    expect(await resume.execute({ transactionId: pending.transactionId, walletId: wallet.id })).toMatchObject({
      type: "decided",
      outcome: { status: WagerTransactionStatus.Failed, failureCode: FailureCode.PermanentInfrastructure, balance: null },
    });
  });

  test("a policy override shortens the attempts", async () => {
    const { store, clock, wallet, send } = await setup();
    const resume = new ResumePending(store, clock, { maxMisses: 2, capSeconds: 1 });
    const pending = await send({ kind: "REFUND", referenceExternalTransactionId: "missing" });

    clock.advance(1000);

    expect(await resume.execute({ transactionId: pending.transactionId, walletId: wallet.id })).toMatchObject({
      type: "decided",
      outcome: { failureCode: FailureCode.ReferenceNotFound },
    });
  });
});
