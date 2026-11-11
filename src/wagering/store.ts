import type { InboxMessage } from "./inbox";
import type { WalletLedgerEntry } from "./ledger";
import type { OutboxMessage } from "./outbox";
import type { WagerTransaction } from "./transaction";
import type { Wallet } from "./wallet";

export const WAGERING_STORE = Symbol("WageringStore");

export interface WalletWrite {
  wallet: Wallet;
  opening?: { transaction: WagerTransaction; entry: WalletLedgerEntry };
  outbox: OutboxMessage[];
}

export interface WagerWrite {
  transaction: WagerTransaction;
  isNew: boolean;
  wallet?: Wallet;
  entry?: WalletLedgerEntry;
  inbox?: InboxMessage;
  outbox: OutboxMessage[];
}

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export interface DueReference {
  transactionId: string;
  walletId: string;
}

export interface WalletSession {
  /** Locks the wallet row until the session ends. Throws CorruptStateError when the row is not valid Money. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  findInbox(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  findWagerByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findWagerByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findProcessedReversal(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Returns the row only when it is still PENDING_REFERENCE, due, and not locked by another session. */
  claimPendingReference(transactionId: string, now: Date): Promise<WagerTransaction | undefined>;
  ledgerEntries(walletId: string): Promise<WalletLedgerEntry[]>;
  /** A UniqueViolationError undoes only this write. The session and its wallet lock stay usable. */
  save(write: WagerWrite): Promise<void>;
}

export interface WageringStore {
  inWallet<T>(walletId: string, work: (session: WalletSession) => Promise<T>): Promise<T>;
  openWallet(write: WalletWrite): Promise<void>;
  findWallet(walletId: string): Promise<Wallet | undefined>;
  findWager(transactionId: string): Promise<WagerTransaction | undefined>;
  findWagerByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  ledgerPage(walletId: string, limit: number, after?: LedgerCursor): Promise<WalletLedgerEntry[]>;
  dueReferences(now: Date, limit: number): Promise<DueReference[]>;
  /** Claims due rows with SKIP LOCKED, runs publish while holding them, then stores each row's new state. */
  claimOutbox(now: Date, limit: number, publish: (messages: OutboxMessage[]) => Promise<void>): Promise<number>;
  oldestUnpublishedOutboxAt(): Promise<Date | undefined>;
  ping(): Promise<void>;
}

export type UniqueConstraint = "player_currency" | "idempotency_key" | "provider_external" | "reversal" | "inbox" | "ledger";

export class UniqueViolationError extends Error {
  override readonly name = "UniqueViolationError";

  constructor(readonly constraint: UniqueConstraint) {
    super(`unique violation on ${constraint}`);
  }
}

export class TransientStoreError extends Error {
  override readonly name = "TransientStoreError";

  constructor(readonly reason: "lock_timeout" | "unavailable") {
    super(`store ${reason}`);
  }
}

export class CorruptStateError extends Error {
  override readonly name = "CorruptStateError";
}
