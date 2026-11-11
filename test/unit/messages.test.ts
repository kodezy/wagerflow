import { describe, expect, test } from "bun:test";

import { FailureCode, InvalidTransactionStateError } from "../../src/wagering/errors";
import { LedgerDirection } from "../../src/wagering/ledger";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/wagering/events";
import { InboxMessage } from "../../src/wagering/inbox";
import { Money } from "../../src/wagering/money";
import { OutboxMessage } from "../../src/wagering/outbox";
import { WagerTransaction, WagerTransactionKind, type CreateWagerTransactionProps } from "../../src/wagering/transaction";
import { Wallet } from "../../src/wagering/wallet";

const at = new Date("2026-11-10T12:00:00.000Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const context = { correlationId: "corr-1", occurredAt: at };

function transaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    createdAt: at,
    ...overrides,
  });
}

const bet = () => transaction();

describe("InboxMessage", () => {
  test("receives once and compares the raw-body hash", () => {
    const message = InboxMessage.receive({ messageId: "msg-1", consumerName: "wager-transactions", payloadHash: "raw-1", receivedAt: at });

    expect(message.isProcessed()).toBe(false);
    message.markProcessed(at);
    expect(message.isProcessed()).toBe(true);
    expect(message.matches("raw-1")).toBe(true);
    expect(message.matches("raw-2")).toBe(false);
    expect(() => message.markProcessed(at)).toThrow(InvalidTransactionStateError);
  });
});

describe("Integration events", () => {
  test("wallet balance changed carries money props and the wallet version", () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl("100.00"), at });
    const entry = wallet.debit({ entryId: "entry-1", transactionId: "tx-1", money: brl("25.00"), at });
    const json = WalletBalanceChanged.from(wallet, entry, context).toJSON();

    expect(json).toEqual({
      eventId: expect.any(String),
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      occurredAt: "2026-11-10T12:00:00.000Z",
      version: 1,
      data: {
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("transaction events carry the observed balance and null ids", () => {
    const processed = bet();
    processed.markProcessed(undefined, brl("75.00"), at);
    const rejected = bet();
    rejected.reject(FailureCode.WalletNotFound, undefined, at);
    const pending = transaction({ id: "tx-2", kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-0" });
    pending.markPendingReference(brl("100.00"), at);

    expect(WagerTransactionProcessed.from(processed, { ...context, causationId: "msg-1" }).toJSON()).toMatchObject({
      eventType: "WagerTransactionProcessed",
      causationId: "msg-1",
      data: { transactionId: "tx-1", kind: "BET", balance: { amount: "75.00", currency: "BRL" }, referenceExternalTransactionId: null },
    });
    expect(WagerTransactionRejected.from(rejected, context).toJSON().data).toMatchObject({ failureCode: "WALLET_NOT_FOUND", balance: null });
    expect(WagerTransactionPendingReference.from(pending, context).toJSON().data).toMatchObject({ referenceExternalTransactionId: "ext-0" });
    expect(() => WagerTransactionRejected.from(processed, context)).toThrow(InvalidTransactionStateError);
  });
});

describe("OutboxMessage", () => {
  test("enqueue keeps the event id and stores the JSON envelope", () => {
    const processed = bet();
    processed.markProcessed(undefined, brl("75.00"), at);
    const event = WagerTransactionProcessed.from(processed, context);
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe("wallet-1");
    expect(message.eventType).toBe("WagerTransactionProcessed");
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
    expect(message.isDue(at)).toBe(true);
  });

  test("retry doubles from 1s up to the cap and never gives up", () => {
    const processed = bet();
    processed.markProcessed(undefined, brl("75.00"), at);
    const message = OutboxMessage.enqueue(WagerTransactionProcessed.from(processed, context));
    const waits: number[] = [];

    for (let attempt = 0; attempt < 9; attempt += 1) {
      message.scheduleRetry(at);
      waits.push(((message.nextAttemptAt as Date).getTime() - at.getTime()) / 1000);
    }

    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    expect(message.attempts).toBe(9);
    expect(message.isDue(at)).toBe(false);

    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(at)).toThrow(InvalidTransactionStateError);
  });
});
