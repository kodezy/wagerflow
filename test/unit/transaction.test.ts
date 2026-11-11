import { describe, expect, test } from "bun:test";

import { FailureCode, InvalidTransactionStateError, ValidationCode, ValidationError } from "../../src/wagering/errors";
import { LedgerDirection } from "../../src/wagering/ledger";
import { Money } from "../../src/wagering/money";
import {
  DEFAULT_REFERENCE_POLICY,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "../../src/wagering/transaction";

const at = new Date("2026-11-10T12:00:00.000Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
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
  };
}

function expectValidation(action: () => unknown, code: ValidationCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(code);
    return;
  }

  throw new Error(`expected ${code}`);
}

describe("WagerTransaction.create", () => {
  test("starts at PENDING", () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.referenceAttempts).toBe(0);
  });

  test("enforces the reference rule per kind", () => {
    expectValidation(() => WagerTransaction.create(props({ kind: WagerTransactionKind.Refund })), ValidationCode.InvalidPayload);
    expectValidation(() => WagerTransaction.create(props({ kind: WagerTransactionKind.Rollback })), ValidationCode.InvalidPayload);
    expectValidation(() => WagerTransaction.create(props({ referenceExternalTransactionId: "ext-0" })), ValidationCode.InvalidPayload);
    expectValidation(
      () => WagerTransaction.create(props({ kind: WagerTransactionKind.Loss, referenceExternalTransactionId: "ext-0" })),
      ValidationCode.InvalidPayload,
    );

    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Win })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: "ext-0" })).kind).toBe(
      WagerTransactionKind.Win,
    );
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-0" })).requiresReference()).toBe(
      true,
    );
  });

  test("refuses OPENING and non-positive amounts, except a zero LOSS", () => {
    expectValidation(() => WagerTransaction.create(props({ kind: WagerTransactionKind.Opening })), ValidationCode.OpeningNotAccepted);
    expectValidation(() => WagerTransaction.create(props({ money: brl("0.00") })), ValidationCode.InvalidMoney);

    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Loss, money: brl("0.00") })).affectsBalance()).toBe(false);
  });

  test("opening uses the opening key and has no provider ids", () => {
    const opening = WagerTransaction.opening({
      id: "tx-0",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("100.00"),
      payloadHash: "hash-0",
      createdAt: at,
    });

    expect(opening.idempotencyKey).toBe("opening:wallet-1");
    expect(opening.providerId).toBeUndefined();
    expect(opening.roundId).toBeUndefined();
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("WagerTransaction transitions", () => {
  test("markProcessed is terminal and records the observed balance", () => {
    const transaction = WagerTransaction.create(props());
    transaction.markProcessed(undefined, brl("75.00"), at);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toEqual(at);
    expect(transaction.observedBalance?.toJSON().amount).toBe("75.00");
    expect(() => transaction.reject(FailureCode.InsufficientBalance, brl("75.00"), at)).toThrow(InvalidTransactionStateError);
    expect(() => transaction.fail(FailureCode.PermanentInfrastructure, at)).toThrow(InvalidTransactionStateError);
    expect(() => transaction.markProcessed(undefined, brl("75.00"), at)).toThrow(InvalidTransactionStateError);
  });

  test("reject and fail are terminal", () => {
    const rejected = WagerTransaction.create(props());
    rejected.reject(FailureCode.InsufficientBalance, brl("10.00"), at);
    const failed = WagerTransaction.create(props());
    failed.fail(FailureCode.PermanentInfrastructure, at);

    expect(rejected.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(failed.observedBalance).toBeUndefined();
    expect(() => rejected.markPendingReference(brl("10.00"), at)).toThrow(InvalidTransactionStateError);
    expect(() => failed.markProcessed(undefined, brl("10.00"), at)).toThrow(InvalidTransactionStateError);
  });

  test("pending reference waits 1, 2, 4 … 60 seconds and the 12th miss rejects", () => {
    const transaction = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-0" }));
    let now = at;
    transaction.markPendingReference(brl("50.00"), now);
    const waits: number[] = [];

    while (transaction.status === WagerTransactionStatus.PendingReference) {
      const next = transaction.nextAttemptAt as Date;
      waits.push((next.getTime() - now.getTime()) / 1000);
      expect(transaction.isAwaitingReference(new Date(next.getTime() - 1))).toBe(false);
      expect(transaction.isAwaitingReference(next)).toBe(true);
      now = next;
      transaction.recordReferenceMiss(brl("50.00"), now);
    }

    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60]);
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(363);
    expect(transaction.referenceAttempts).toBe(DEFAULT_REFERENCE_POLICY.maxMisses);
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(transaction.nextAttemptAt).toBeUndefined();
  });

  test("a policy override changes the limit", () => {
    const transaction = WagerTransaction.create(props({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: "ext-0" }));
    const policy = { maxMisses: 2, capSeconds: 1 };
    transaction.markPendingReference(brl("1.00"), at, policy);
    transaction.recordReferenceMiss(brl("1.00"), at, policy);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("PENDING_REFERENCE exits to PROCESSED and overwrites the observed balance", () => {
    const transaction = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-0" }));
    transaction.markPendingReference(brl("50.00"), at);
    transaction.markProcessed("tx-0", brl("75.00"), at);

    expect(transaction.referenceTransactionId).toBe("tx-0");
    expect(transaction.observedBalance?.toJSON().amount).toBe("75.00");
    expect(() => transaction.recordReferenceMiss(brl("1.00"), at)).toThrow(InvalidTransactionStateError);
  });
});

describe("WagerTransaction queries", () => {
  const bet = WagerTransaction.create(props());
  const win = WagerTransaction.create(props({ kind: WagerTransactionKind.Win }));
  const refund = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-0" }));
  const rollback = WagerTransaction.create(props({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-0" }));
  const loss = WagerTransaction.create(props({ kind: WagerTransactionKind.Loss }));

  test("ledger direction per kind", () => {
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test("accepted reference kinds", () => {
    expect(win.acceptsReference(bet)).toBe(true);
    expect(refund.acceptsReference(bet)).toBe(true);
    expect(refund.acceptsReference(win)).toBe(false);
    expect(rollback.acceptsReference(win)).toBe(true);
    expect(rollback.acceptsReference(refund)).toBe(true);
    expect(rollback.acceptsReference(loss)).toBe(false);
    expect(rollback.acceptsReference(rollback)).toBe(false);
  });

  test("payload match and rehydrate", () => {
    const state = { ...bet.toState(), status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientBalance };

    expect(bet.matchesPayload("hash-1")).toBe(true);
    expect(bet.matchesPayload("hash-2")).toBe(false);
    expect(WagerTransaction.rehydrate(state).isTerminal()).toBe(true);
  });
});
