import { ValidationCode, ValidationError, type FailureCode } from "./errors";
import type { LedgerDirection, WalletLedgerEntry } from "./ledger";
import type { MoneyProps } from "./money";
import type { LedgerCursor, WageringStore } from "./store";
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./transaction";
import type { Wallet } from "./wallet";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface LedgerQuery {
  cursor?: unknown;
  limit?: unknown;
}

export interface TransactionView {
  transactionId: string;
  status: WagerTransactionStatus;
  kind: WagerTransactionKind;
  providerId: string | null;
  externalTransactionId: string | null;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  money: MoneyProps;
  balance: MoneyProps | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  createdAt: string;
  processedAt: string | null;
}

export class QueryWagering {
  constructor(private readonly store: WageringStore) {}

  async wallet(walletId: string): Promise<WalletView | undefined> {
    const wallet = await this.store.findWallet(walletId);
    return wallet && walletView(wallet);
  }

  async ledger(walletId: string, query: LedgerQuery = {}): Promise<LedgerPage | undefined> {
    const limit = parseLimit(query.limit);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    const wallet = await this.store.findWallet(walletId);
    if (!wallet) return undefined;

    const entries = await this.store.ledgerPage(walletId, limit + 1, after);
    const items = entries.slice(0, limit);
    const last = items.at(-1);

    return { items: items.map(entryView), nextCursor: entries.length > limit && last ? encodeCursor(last) : null };
  }

  async transaction(transactionId: string): Promise<TransactionView | undefined> {
    const transaction = await this.store.findWager(transactionId);
    return transaction && transactionView(transaction);
  }

  async transactionByExternal(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined> {
    const transaction = await this.store.findWagerByProviderExternal(providerId, externalTransactionId);
    return transaction && transactionView(transaction);
  }
}

export function walletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;

  const limit = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) throw new ValidationError(ValidationCode.InvalidPayload, "limit");

  return limit;
}

function encodeCursor(entry: WalletLedgerEntry): string {
  return Buffer.from(JSON.stringify({ createdAt: entry.createdAt.toISOString(), id: entry.id })).toString("base64url");
}

function decodeCursor(value: unknown): LedgerCursor {
  const cursor = typeof value === "string" ? readCursor(value) : undefined;
  if (!cursor) throw new ValidationError(ValidationCode.InvalidPayload, "cursor");

  return cursor;
}

function readCursor(value: string): LedgerCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const { createdAt, id } = parsed as Record<string, unknown>;
    if (typeof createdAt !== "string" || typeof id !== "string" || !UUID.test(id)) return undefined;

    const date = new Date(createdAt);
    return Number.isNaN(date.getTime()) ? undefined : { createdAt: date, id };
  } catch {
    return undefined;
  }
}

function entryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

function transactionView(transaction: WagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    kind: transaction.kind,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    money: transaction.money.toJSON(),
    balance: transaction.observedBalance?.toJSON() ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
