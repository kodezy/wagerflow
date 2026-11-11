import { InvalidTransactionStateError, type FailureCode } from "./errors";
import type { LedgerDirection, WalletLedgerEntry } from "./ledger";
import type { MoneyProps } from "./money";
import type { WagerTransaction, WagerTransactionKind } from "./transaction";
import type { Wallet } from "./wallet";

export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventJSON<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export interface WagerTransactionData {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps | null;
  providerId: string | null;
  externalTransactionId: string | null;
  roundId: string | null;
  gameId: string | null;
  referenceExternalTransactionId: string | null;
}

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: FailureCode;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventJSON<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = "WalletBalanceChanged";
  override readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: Bun.randomUUIDv7(),
      aggregateId: wallet.id,
      ...context,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionData> {
  override readonly eventType = "WagerTransactionProcessed";
  override readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ eventId: Bun.randomUUIDv7(), aggregateId: transaction.walletId, ...context, data: wagerData(transaction) });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = "WagerTransactionRejected";
  override readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const failureCode = transaction.failureCode;
    if (failureCode === undefined) throw new InvalidTransactionStateError(`transaction ${transaction.id} has no failure code`);

    return new WagerTransactionRejected({
      eventId: Bun.randomUUIDv7(),
      aggregateId: transaction.walletId,
      ...context,
      data: { ...wagerData(transaction), failureCode },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionData> {
  override readonly eventType = "WagerTransactionPendingReference";
  override readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: Bun.randomUUIDv7(),
      aggregateId: transaction.walletId,
      ...context,
      data: wagerData(transaction),
    });
  }
}

function wagerData(transaction: WagerTransaction): WagerTransactionData {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    balance: transaction.observedBalance?.toJSON() ?? null,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
  };
}
