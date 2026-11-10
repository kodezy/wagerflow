import { LockMode } from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Decimal } from "decimal.js";

import type { FailureCode } from "../wagering/errors";
import { InboxMessage } from "../wagering/inbox";
import { WalletLedgerEntry, type LedgerDirection } from "../wagering/ledger";
import { Money } from "../wagering/money";
import { OutboxMessage } from "../wagering/outbox";
import {
  CorruptStateError,
  TransientStoreError,
  UniqueViolationError,
  type DueReference,
  type LedgerCursor,
  type UniqueConstraint,
  type WagerWrite,
  type WageringStore,
  type WalletSession,
  type WalletWrite,
} from "../wagering/store";
import { WagerTransaction, WagerTransactionStatus, type WagerTransactionKind } from "../wagering/transaction";
import { Wallet } from "../wagering/wallet";
import { InboxRow, LedgerRow, OutboxRow, WagerRow, WalletRow } from "./rows";

export class PostgresWageringStore implements WageringStore {
  constructor(private readonly orm: MikroORM) {}

  inWallet<T>(walletId: string, work: (session: WalletSession) => Promise<T>): Promise<T> {
    return translateErrors(() =>
      this.orm.em.fork().transactional(async (em) => {
        await em.execute("set local lock_timeout = '2s'");
        return work(new PostgresWalletSession(em));
      }),
    );
  }

  openWallet(write: WalletWrite): Promise<void> {
    return translateErrors(() =>
      this.orm.em.fork().transactional(async (em) => {
        await em.insert(WalletRow, walletRow(write.wallet));
        if (write.opening) {
          await em.insert(WagerRow, wagerRow(write.opening.transaction));
          await em.insert(LedgerRow, ledgerRow(write.opening.entry));
        }
        for (const message of write.outbox) await em.insert(OutboxRow, outboxRow(message));
      }),
    );
  }

  findWallet(walletId: string): Promise<Wallet | undefined> {
    return translateErrors(async () => {
      if (!isUuid(walletId)) return undefined;

      const row = await this.orm.em.fork().findOne(WalletRow, { id: walletId });
      return row ? toWallet(row) : undefined;
    });
  }

  findWager(transactionId: string): Promise<WagerTransaction | undefined> {
    return translateErrors(async () => {
      if (!isUuid(transactionId)) return undefined;

      const row = await this.orm.em.fork().findOne(WagerRow, { id: transactionId });
      return row ? toWager(row) : undefined;
    });
  }

  findWagerByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return translateErrors(async () => {
      const row = await this.orm.em.fork().findOne(WagerRow, { providerId, externalTransactionId });
      return row ? toWager(row) : undefined;
    });
  }

  ledgerPage(walletId: string, limit: number, after?: LedgerCursor): Promise<WalletLedgerEntry[]> {
    return translateErrors(async () => {
      if (!isUuid(walletId)) return [];

      const em = this.orm.em.fork();
      const rows = after
        ? await em.find(
            LedgerRow,
            { walletId, $or: [{ createdAt: { $gt: after.createdAt } }, { createdAt: after.createdAt, id: { $gt: after.id } }] },
            { orderBy: { createdAt: "asc", id: "asc" }, limit },
          )
        : await em.find(LedgerRow, { walletId }, { orderBy: { createdAt: "asc", id: "asc" }, limit });

      return rows.map(toLedgerEntry);
    });
  }

  dueReferences(now: Date, limit: number): Promise<DueReference[]> {
    return translateErrors(async () => {
      const rows = await this.orm.em
        .fork()
        .find(WagerRow, { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } }, { orderBy: { nextAttemptAt: "asc" }, limit });

      return rows.map((row) => ({ transactionId: row.id, walletId: row.walletId }));
    });
  }

  claimOutbox(now: Date, limit: number, publish: (messages: OutboxMessage[]) => Promise<void>): Promise<number> {
    return translateErrors(() =>
      this.orm.em.fork().transactional(async (em) => {
        const rows = await em.find(
          OutboxRow,
          { publishedAt: null, nextAttemptAt: { $lte: now } },
          { orderBy: { nextAttemptAt: "asc", id: "asc" }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
        );
        if (rows.length === 0) return 0;

        const messages = rows.map(toOutbox);
        await publish(messages);

        for (const message of messages) await em.nativeUpdate(OutboxRow, { id: message.id }, outboxProgress(message));
        return messages.length;
      }),
    );
  }

  oldestUnpublishedOutboxAt(): Promise<Date | undefined> {
    return translateErrors(async () => {
      const row = await this.orm.em.fork().findOne(OutboxRow, { publishedAt: null }, { orderBy: { occurredAt: "asc" } });
      return row?.occurredAt;
    });
  }

  ping(): Promise<void> {
    return translateErrors(async () => {
      await this.orm.em.fork().execute("select 1");
    });
  }
}

class PostgresWalletSession implements WalletSession {
  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    if (!isUuid(walletId)) return undefined;

    const row = await this.em.findOne(WalletRow, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? toWallet(row) : undefined;
  }

  async findInbox(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxRow, { consumerName, messageId });
    return row ? toInbox(row) : undefined;
  }

  async findWagerByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerRow, { idempotencyKey });
    return row ? toWager(row) : undefined;
  }

  async findWagerByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerRow, { providerId, externalTransactionId });
    return row ? toWager(row) : undefined;
  }

  async findProcessedReversal(referenceTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerRow, {
      referenceTransactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: WagerTransactionStatus.Processed,
    });
    return row ? toWager(row) : undefined;
  }

  async claimPendingReference(transactionId: string, now: Date): Promise<WagerTransaction | undefined> {
    if (!isUuid(transactionId)) return undefined;

    const row = await this.em.findOne(
      WagerRow,
      { id: transactionId, status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return row ? toWager(row) : undefined;
  }

  async ledgerEntries(walletId: string): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(LedgerRow, { walletId }, { orderBy: { createdAt: "asc", id: "asc" } });
    return rows.map(toLedgerEntry);
  }

  async save(write: WagerWrite): Promise<void> {
    await this.em.execute("savepoint wager_write");

    try {
      await this.write(write);
    } catch (error) {
      await this.em.execute("rollback to savepoint wager_write");
      throw translate(error);
    }

    await this.em.execute("release savepoint wager_write");
  }

  private async write({ transaction, isNew, wallet, entry, inbox, outbox }: WagerWrite): Promise<void> {
    if (wallet) await this.updateWallet(wallet);
    if (isNew) await this.em.insert(WagerRow, wagerRow(transaction));
    else await this.updatePending(transaction);
    if (entry) await this.em.insert(LedgerRow, ledgerRow(entry));
    if (inbox) await this.em.insert(InboxRow, inboxRow(inbox));
    for (const message of outbox) await this.em.insert(OutboxRow, outboxRow(message));
  }

  private async updateWallet(wallet: Wallet): Promise<void> {
    const { balanceAmount, balanceCurrency, version, updatedAt } = walletRow(wallet);
    const updated = await this.em.nativeUpdate(WalletRow, { id: wallet.id }, { balanceAmount, balanceCurrency, version, updatedAt });

    if (updated !== 1) throw new CorruptStateError(`wallet ${wallet.id} was not updated`);
  }

  private async updatePending(transaction: WagerTransaction): Promise<void> {
    const row = wagerRow(transaction);
    const updated = await this.em.nativeUpdate(
      WagerRow,
      { id: transaction.id, status: WagerTransactionStatus.PendingReference },
      {
        status: row.status,
        referenceTransactionId: row.referenceTransactionId,
        failureCode: row.failureCode,
        observedBalanceAmount: row.observedBalanceAmount,
        observedBalanceCurrency: row.observedBalanceCurrency,
        referenceAttempts: row.referenceAttempts,
        nextAttemptAt: row.nextAttemptAt,
        processedAt: row.processedAt,
      },
    );

    if (updated !== 1) throw new CorruptStateError(`pending transaction ${transaction.id} was not updated`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTION_MESSAGE = /timeout exceeded when trying to connect|Connection terminated/i;
const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "57P01", "57P02", "57P03", "53300"]);
const UNIQUE_CONSTRAINTS: Partial<Record<string, UniqueConstraint>> = {
  wallets_player_currency_unique: "player_currency",
  wager_transactions_idempotency_key_unique: "idempotency_key",
  wager_transactions_provider_external_unique: "provider_external",
  wager_transactions_reversal_unique: "reversal",
  inbox_messages_pkey: "inbox",
  wallet_ledger_entries_transaction_wallet_unique: "ledger",
};

async function translateErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translate(error);
  }
}

function translate(error: unknown): unknown {
  if (!(error instanceof Error)) return error;

  const { code, constraint } = error as Error & { code?: unknown; constraint?: unknown };
  const unique = typeof constraint === "string" ? UNIQUE_CONSTRAINTS[constraint] : undefined;

  if (code === "23505" && unique) return new UniqueViolationError(unique);
  if (code === "55P03" || code === "40P01" || code === "40001") return new TransientStoreError("lock_timeout");
  if (typeof code === "string" && (code.startsWith("08") || UNAVAILABLE_CODES.has(code))) return new TransientStoreError("unavailable");
  if (code === undefined && CONNECTION_MESSAGE.test(error.message)) return new TransientStoreError("unavailable");

  return error;
}

function isUuid(value: string): boolean {
  return UUID.test(value);
}

function toMoney(amount: string, currency: string): Money {
  try {
    return Money.from({ amount: new Decimal(amount).toFixed(2), currency });
  } catch {
    throw new CorruptStateError("stored amount is not valid Money");
  }
}

function toOptionalMoney(amount: string | null, currency: string | null): Money | undefined {
  return amount === null || currency === null ? undefined : toMoney(amount, currency);
}

function walletRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.toJSON().amount,
    balanceCurrency: wallet.balance.currency,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: toMoney(row.balanceAmount, row.balanceCurrency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function wagerRow(transaction: WagerTransaction): WagerRow {
  const state = transaction.toState();

  return {
    id: state.id,
    providerId: state.providerId ?? null,
    externalTransactionId: state.externalTransactionId ?? null,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    walletId: state.walletId,
    playerId: state.playerId,
    roundId: state.roundId ?? null,
    gameId: state.gameId ?? null,
    kind: state.kind,
    amount: state.money.toJSON().amount,
    currency: state.money.currency,
    referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
    referenceTransactionId: state.referenceTransactionId ?? null,
    status: state.status,
    failureCode: state.failureCode ?? null,
    observedBalanceAmount: state.observedBalance?.toJSON().amount ?? null,
    observedBalanceCurrency: state.observedBalance?.currency ?? null,
    referenceAttempts: state.referenceAttempts,
    nextAttemptAt: state.nextAttemptAt ?? null,
    createdAt: state.createdAt,
    processedAt: state.processedAt ?? null,
  };
}

function toWager(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId ?? undefined,
    externalTransactionId: row.externalTransactionId ?? undefined,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId ?? undefined,
    gameId: row.gameId ?? undefined,
    kind: row.kind as WagerTransactionKind,
    money: toMoney(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: row.processedAt ?? undefined,
    observedBalance: toOptionalMoney(row.observedBalanceAmount, row.observedBalanceCurrency),
    referenceAttempts: row.referenceAttempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
  });
}

function ledgerRow(entry: WalletLedgerEntry): LedgerRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    currency: entry.money.currency,
    createdAt: entry.createdAt,
  };
}

function toLedgerEntry(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: toMoney(row.amount, row.currency),
    balanceBefore: toMoney(row.balanceBefore, row.currency),
    balanceAfter: toMoney(row.balanceAfter, row.currency),
    createdAt: row.createdAt,
  });
}

function inboxRow(message: InboxMessage): InboxRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

function toInbox(row: InboxRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}

function outboxRow(message: OutboxMessage): OutboxRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    ...outboxProgress(message),
  };
}

function outboxProgress(message: OutboxMessage): Pick<OutboxRow, "attempts" | "nextAttemptAt" | "publishedAt"> {
  return { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt ?? null, publishedAt: message.publishedAt ?? null };
}

function toOutbox(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}
