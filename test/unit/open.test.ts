import { describe, expect, test } from "bun:test";

import { ConflictCode } from "../../src/wagering/errors";
import { LedgerDirection } from "../../src/wagering/ledger";
import { OpenWallet } from "../../src/wagering/open";
import { parseWalletRequest } from "../../src/wagering/request";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/wagering/transaction";
import { FakeClock } from "../fakes/clock";
import { FakeStore } from "../fakes/store";
import { openWallet } from "../helpers/wagering";

describe("OpenWallet", () => {
  test("a positive balance writes OPENING, one credit, and two events in one write", async () => {
    const store = new FakeStore();
    const wallet = await openWallet(store, new FakeClock(), { amount: "1000.00" });
    const [opening] = [...store.wagers.values()];

    expect(wallet.version).toBe(1);
    expect(opening).toMatchObject({
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      idempotencyKey: `opening:${wallet.id}`,
      providerId: undefined,
      externalTransactionId: undefined,
      roundId: undefined,
    });
    expect(opening?.observedBalance?.toJSON().amount).toBe("1000.00");
    expect(store.ledger.map((entry) => entry.direction)).toEqual([LedgerDirection.Credit]);
    expect(store.eventTypes(wallet.id)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(store.ledgerFold(wallet.id)).toBe("1000.00");
  });

  test("a zero balance writes neither the transaction nor the ledger", async () => {
    const store = new FakeStore();
    const wallet = await openWallet(store, new FakeClock(), { amount: "0.00" });

    expect(wallet.version).toBe(1);
    expect(store.wagers.size).toBe(0);
    expect(store.ledger).toHaveLength(0);
    expect(store.outbox.size).toBe(0);
  });

  test("one wallet per player and currency", async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const open = new OpenWallet(store, clock);
    const request = (currency: string) => parseWalletRequest({ playerId: "player-1", initialBalance: { amount: "1.00", currency } });

    expect((await open.execute(request("BRL"), "c")).type).toBe("opened");
    expect(await open.execute(request("BRL"), "c")).toEqual({ type: "conflict", code: ConflictCode.DuplicateWallet });
    expect((await open.execute(request("USD"), "c")).type).toBe("opened");
  });
});
