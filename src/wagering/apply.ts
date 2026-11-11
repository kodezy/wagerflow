import { EventSerializationError, FailureCode } from "./errors";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from "./events";
import type { InboxMessage } from "./inbox";
import { LedgerDirection } from "./ledger";
import type { Money, MoneyProps } from "./money";
import { OutboxMessage } from "./outbox";
import { CorruptStateError, type WagerWrite, type WalletSession } from "./store";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, type ReferencePolicy } from "./transaction";
import type { Wallet } from "./wallet";

export interface WagerOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

export type WalletLock = { state: "ready"; wallet: Wallet } | { state: "missing" } | { state: "unreadable" };

export interface WriteContext {
  at: Date;
  events: EventContext;
  policy: ReferencePolicy;
  isNew: boolean;
  inbox?: InboxMessage;
}

export async function lockWallet(session: WalletSession, walletId: string): Promise<WalletLock> {
  try {
    const wallet = await session.lockWallet(walletId);
    return wallet ? { state: "ready", wallet } : { state: "missing" };
  } catch (error) {
    if (error instanceof CorruptStateError) return { state: "unreadable" };
    throw error;
  }
}

export async function decideOrFail(
  transaction: WagerTransaction,
  context: WriteContext,
  decide: (transaction: WagerTransaction) => Promise<WagerWrite>,
): Promise<WagerWrite> {
  const snapshot = transaction.toState();

  try {
    return await decide(transaction);
  } catch (error) {
    if (!(error instanceof EventSerializationError)) throw error;
    return failWager(WagerTransaction.rehydrate(snapshot), context);
  }
}

export async function settleWager(session: WalletSession, transaction: WagerTransaction, wallet: Wallet, context: WriteContext): Promise<WagerWrite> {
  const providerId = transaction.providerId;
  const referenceId = transaction.referenceExternalTransactionId;
  if (providerId === undefined || referenceId === undefined) return applyWager(transaction, wallet, undefined, context);

  const reference = await session.findWagerByProviderExternal(providerId, referenceId);
  if (!reference || reference.status === WagerTransactionStatus.PendingReference) return awaitReference(transaction, wallet, context);

  const failure = await referenceFailure(session, transaction, reference);
  if (failure) return rejectWager(transaction, failure, wallet.balance, context);

  return applyWager(transaction, wallet, reference, context);
}

export function rejectWager(transaction: WagerTransaction, code: FailureCode, observedBalance: Money | undefined, context: WriteContext): WagerWrite {
  transaction.reject(code, observedBalance, context.at);
  return writeOf(transaction, context, [WagerTransactionRejected.from(transaction, context.events)]);
}

export function failWager(transaction: WagerTransaction, context: WriteContext): WagerWrite {
  transaction.fail(FailureCode.PermanentInfrastructure, context.at);
  return writeOf(transaction, context, []);
}

export function outcomeOf(transaction: WagerTransaction, idempotentReplay: boolean): WagerOutcome {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    failureCode: transaction.failureCode ?? null,
    idempotentReplay,
  };
}

function applyWager(transaction: WagerTransaction, wallet: Wallet, reference: WagerTransaction | undefined, context: WriteContext): WagerWrite {
  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, wallet.balance, context.at);
    return writeOf(transaction, context, [WagerTransactionProcessed.from(transaction, context.events)]);
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canCover(transaction.money)) {
    const code = transaction.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientBalance : FailureCode.ReversalInsufficientBalance;
    return rejectWager(transaction, code, wallet.balance, context);
  }

  const movement = { entryId: Bun.randomUUIDv7(), transactionId: transaction.id, money: transaction.money, at: context.at };
  const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed(reference?.id, wallet.balance, context.at);

  const events = [WagerTransactionProcessed.from(transaction, context.events), WalletBalanceChanged.from(wallet, entry, context.events)];
  return { ...writeOf(transaction, context, events), wallet, entry };
}

function awaitReference(transaction: WagerTransaction, wallet: Wallet, context: WriteContext): WagerWrite {
  if (transaction.status === WagerTransactionStatus.Pending) {
    transaction.markPendingReference(wallet.balance, context.at, context.policy);
    return writeOf(transaction, context, [WagerTransactionPendingReference.from(transaction, context.events)]);
  }

  transaction.recordReferenceMiss(wallet.balance, context.at, context.policy);
  const events = transaction.status === WagerTransactionStatus.Rejected ? [WagerTransactionRejected.from(transaction, context.events)] : [];

  return writeOf(transaction, context, events);
}

async function referenceFailure(session: WalletSession, transaction: WagerTransaction, reference: WagerTransaction): Promise<FailureCode | undefined> {
  if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
  if (!transaction.acceptsReference(reference)) return FailureCode.ReferenceKindMismatch;
  if (reference.money.currency !== transaction.money.currency) return FailureCode.CurrencyMismatch;
  if (!sameScope(transaction, reference)) return FailureCode.ReferenceScopeMismatch;
  if (!transaction.requiresReference()) return undefined;
  if (!reference.money.equals(transaction.money)) return FailureCode.AmountMismatch;
  if (await session.findProcessedReversal(reference.id)) return FailureCode.ReferenceAlreadyReversed;

  return undefined;
}

function sameScope(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    transaction.providerId === reference.providerId &&
    transaction.playerId === reference.playerId &&
    transaction.walletId === reference.walletId &&
    transaction.roundId === reference.roundId
  );
}

function writeOf(transaction: WagerTransaction, context: WriteContext, events: IntegrationEvent<unknown>[]): WagerWrite {
  return { transaction, isNew: context.isNew, inbox: context.inbox, outbox: events.map((event) => OutboxMessage.enqueue(event)) };
}
