import { describe, expect, test } from "bun:test";

import { ValidationError } from "../../src/wagering/errors";
import { Money } from "../../src/wagering/money";
import { QueryWagering } from "../../src/wagering/query";
import { ReconcileWallet } from "../../src/wagering/reconcile";
import { SubmitWager } from "../../src/wagering/submit";
import { FakeClock } from "../fakes/clock";
import { FakeStore } from "../fakes/store";
import { expectOutcome, openWallet, wagerRequest } from "../helpers/wagering";

async function setup() {
  const store = new FakeStore();
  const clock = new FakeClock();
  const wallet = await openWallet(store, clock);
  const submit = new SubmitWager(store, clock);

  for (const externalTransactionId of ["bet-1", "bet-2", "bet-3"]) {
    clock.advance(1);
    await submit.execute({ request: wagerRequest(wallet, { externalTransactionId, money: { amount: "1.00", currency: "BRL" } }), correlationId: "c" });
  }

  return { store, clock, wallet, submit, query: new QueryWagering(store), reconcile: new ReconcileWallet(store) };
}

describe("QueryWagering", () => {
  test("wallet view and unknown ids", async () => {
    const { wallet, query } = await setup();

    expect(await query.wallet(wallet.id)).toMatchObject({ id: wallet.id, playerId: wallet.playerId, balance: { amount: "97.00", currency: "BRL" }, version: 4 });
    expect(await query.wallet(Bun.randomUUIDv7())).toBeUndefined();
    expect(await query.ledger(Bun.randomUUIDv7())).toBeUndefined();
    expect(await query.transaction(Bun.randomUUIDv7())).toBeUndefined();
  });

  test("ledger pages follow a stable opaque cursor", async () => {
    const { store, wallet, query } = await setup();
    const first = await query.ledger(wallet.id, { limit: "2" });
    const second = await query.ledger(wallet.id, { limit: "2", cursor: first?.nextCursor ?? undefined });
    const all = await query.ledger(wallet.id);

    expect(first?.items).toHaveLength(2);
    expect(first?.nextCursor).toEqual(expect.any(String));
    expect(second?.items).toHaveLength(2);
    expect(second?.nextCursor).toBeNull();
    expect([...(first?.items ?? []), ...(second?.items ?? [])].map((item) => item.id)).toEqual(all?.items.map((item) => item.id) ?? []);
    expect(all?.items.map((item) => item.balanceAfter.amount)).toEqual(["100.00", "99.00", "98.00", "97.00"]);
    expect(store.ledger).toHaveLength(4);
  });

  test("invalid cursor and limit are validation errors", async () => {
    const { wallet, query } = await setup();

    for (const limit of ["0", "101", "abc", "1.5"]) await expect(query.ledger(wallet.id, { limit })).rejects.toBeInstanceOf(ValidationError);
    await expect(query.ledger(wallet.id, { cursor: "nope" })).rejects.toBeInstanceOf(ValidationError);
  });

  test("transaction lookups by id and by provider id", async () => {
    const { wallet, submit, query } = await setup();
    const outcome = expectOutcome(await submit.execute({ request: wagerRequest(wallet, { externalTransactionId: "bet-9" }), correlationId: "c" }));

    expect(await query.transaction(outcome.transactionId)).toMatchObject({ transactionId: outcome.transactionId, status: "PROCESSED", kind: "BET" });
    expect(await query.transactionByExternal("provider-a", "bet-9")).toMatchObject({ transactionId: outcome.transactionId, balance: { amount: "72.00" } });
    expect(await query.transactionByExternal("provider-a", "unknown")).toBeUndefined();
  });
});

describe("ReconcileWallet", () => {
  test("reports consistency and flags a difference without rewriting", async () => {
    const { store, wallet, reconcile } = await setup();

    expect(await reconcile.execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "97.00", currency: "BRL" },
      calculatedBalance: { amount: "97.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 4,
    });

    const state = store.wallets.get(wallet.id)!;
    store.wallets.set(wallet.id, { ...state, balance: Money.from({ amount: "90.00", currency: "BRL" }) });

    expect(await reconcile.execute(wallet.id)).toMatchObject({ consistent: false, difference: { amount: "-7.00", currency: "BRL" } });
    expect(store.balanceOf(wallet.id)).toBe("90.00");
    expect(await reconcile.execute(Bun.randomUUIDv7())).toBeUndefined();
  });
});
