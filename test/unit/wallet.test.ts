import { describe, expect, test } from "bun:test";

import { CurrencyMismatchError, InsufficientBalanceError, UnbalancedLedgerError } from "../../src/wagering/errors";
import { LedgerDirection, WalletLedgerEntry } from "../../src/wagering/ledger";
import { Money } from "../../src/wagering/money";
import { Wallet } from "../../src/wagering/wallet";

const at = new Date("2026-11-10T12:00:00.000Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const open = (amount = "100.00") => Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl(amount), at });
const movement = (amount: string) => ({ entryId: "entry-1", transactionId: "tx-1", money: brl(amount), at });

describe("Wallet", () => {
  test("opens at version 1 with the initial balance", () => {
    const wallet = open();

    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(open("0.00").version).toBe(1);
  });

  test("debit moves the balance, bumps the version, and returns a balanced entry", () => {
    const wallet = open();
    const entry = wallet.debit(movement("25.00"));

    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("credit moves the balance up", () => {
    const wallet = open();
    const entry = wallet.credit(movement("0.50"));

    expect(wallet.balance.toJSON().amount).toBe("100.50");
    expect(entry.signedMoney().toJSON().amount).toBe("0.50");
  });

  test("never goes negative and leaves state untouched on failure", () => {
    const wallet = open("10.00");

    expect(wallet.canCover(brl("10.01"))).toBe(false);
    expect(() => wallet.debit(movement("10.01"))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects another currency", () => {
    const wallet = open();
    const usd = { ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };

    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canCover(usd.money)).toThrow(CurrencyMismatchError);
  });

  test("rehydrate restores state without checks", () => {
    const state = { ...open().toState(), version: 7 };

    expect(Wallet.rehydrate(state).version).toBe(7);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Credit,
    money: brl("5.00"),
    balanceBefore: brl("10.00"),
    balanceAfter: brl("15.00"),
    createdAt: at,
  };

  test("create checks the arithmetic", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("14.99") })).toThrow(UnbalancedLedgerError);
    expect(() => WalletLedgerEntry.create({ ...base, money: brl("0.00"), balanceAfter: brl("10.00") })).toThrow(UnbalancedLedgerError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl("11.00"), balanceAfter: brl("10.00").subtract(brl("11.00")) }),
    ).toThrow(UnbalancedLedgerError);
  });

  test("debit entries fold as negative money", () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, balanceAfter: brl("5.00") });

    expect(entry.signedMoney().toJSON().amount).toBe("-5.00");
  });

  test("has no mutators", () => {
    const entry = WalletLedgerEntry.create(base);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));

    expect(methods.sort()).toEqual(["constructor", "isBalanced", "signedMoney", "toState"]);
  });
});
