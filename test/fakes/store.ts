import { InboxMessage, type InboxMessageState } from "../../src/wagering/inbox";
import { WalletLedgerEntry, type LedgerEntryState } from "../../src/wagering/ledger";
import { Money } from "../../src/wagering/money";
import { OutboxMessage, type OutboxMessageState } from "../../src/wagering/outbox";
import {
  CorruptStateError,
  UniqueViolationError,
  type DueReference,
  type LedgerCursor,
  type WagerWrite,
  type WageringStore,
  type WalletSession,
  type WalletWrite,
} from "../../src/wagering/store";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from "../../src/wagering/transaction";
import { Wallet, type WalletState } from "../../src/wagering/wallet";

export class FakeStore implements WageringStore {
  readonly wallets = new Map<string, WalletState>();
  readonly wagers = new Map<string, WagerTransactionState>();
  readonly ledger: LedgerEntryState[] = [];
  readonly inbox = new Map<string, InboxMessageState>();
  readonly outbox = new Map<string, OutboxMessageState>();
  readonly corruptWallets = new Set<string>();
  beforeNextSave?: () => void;
  private readonly locks = new Map<string, Promise<void>>();

  async inWallet<T>(walletId: string, work: (session: WalletSession) => Promise<T>): Promise<T> {
    const release = await this.lock(walletId);

    try {
      return await work(this.session());
    } finally {
      release();
    }
  }

  async openWallet(write: WalletWrite): Promise<void> {
    const { wallet, opening, outbox } = write;

    for (const stored of this.wallets.values()) {
      if (stored.playerId === wallet.playerId && stored.currency === wallet.currency) throw new UniqueViolationError("player_currency");
    }

    this.wallets.set(wallet.id, wallet.toState());
    if (opening) {
      this.wagers.set(opening.transaction.id, opening.transaction.toState());
      this.ledger.push(opening.entry.toState());
    }
    for (const message of outbox) this.outbox.set(message.id, message.toState());
  }

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    return this.readWallet(walletId);
  }

  async findWager(transactionId: string): Promise<WagerTransaction | undefined> {
    const state = this.wagers.get(transactionId);
    return state && WagerTransaction.rehydrate(state);
  }

  async findWagerByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findWagerBy((state) => state.providerId === providerId && state.externalTransactionId === externalTransactionId);
  }

  async ledgerPage(walletId: string, limit: number, after?: LedgerCursor): Promise<WalletLedgerEntry[]> {
    return this.ledgerOf(walletId)
      .filter((entry) => !after || compareEntries(entry, after) > 0)
      .slice(0, limit)
      .map((entry) => WalletLedgerEntry.rehydrate(entry));
  }

  async dueReferences(now: Date, limit: number): Promise<DueReference[]> {
    return [...this.wagers.values()]
      .filter((state) => WagerTransaction.rehydrate(state).isAwaitingReference(now))
      .sort((left, right) => (left.nextAttemptAt as Date).getTime() - (right.nextAttemptAt as Date).getTime())
      .slice(0, limit)
      .map((state) => ({ transactionId: state.id, walletId: state.walletId }));
  }

  async claimOutbox(now: Date, limit: number, publish: (messages: OutboxMessage[]) => Promise<void>): Promise<number> {
    const due = [...this.outbox.values()]
      .map((state) => OutboxMessage.rehydrate(state))
      .filter((message) => message.isDue(now))
      .slice(0, limit);
    if (due.length === 0) return 0;

    await publish(due);
    for (const message of due) this.outbox.set(message.id, message.toState());

    return due.length;
  }

  async oldestUnpublishedOutboxAt(): Promise<Date | undefined> {
    const pending = [...this.outbox.values()].filter((state) => state.publishedAt === undefined);
    return pending.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())[0]?.occurredAt;
  }

  async ping(): Promise<void> {}

  balanceOf(walletId: string): string | undefined {
    return this.wallets.get(walletId)?.balance.toJSON().amount;
  }

  ledgerFold(walletId: string): string {
    const currency = this.wallets.get(walletId)?.currency ?? "BRL";
    const fold = this.ledgerOf(walletId).reduce((sum, entry) => sum.add(WalletLedgerEntry.rehydrate(entry).signedMoney()), Money.zero(currency));

    return fold.toJSON().amount;
  }

  eventTypes(aggregateId: string): string[] {
    return [...this.outbox.values()].filter((state) => state.aggregateId === aggregateId).map((state) => state.eventType);
  }

  private session(): WalletSession {
    return {
      lockWallet: async (walletId) => this.readWallet(walletId),
      findInbox: async (consumerName, messageId) => {
        const state = this.inbox.get(inboxKey(consumerName, messageId));
        return state && InboxMessage.rehydrate(state);
      },
      findWagerByIdempotencyKey: async (idempotencyKey) => this.findWagerBy((state) => state.idempotencyKey === idempotencyKey),
      findWagerByProviderExternal: (providerId, externalTransactionId) => this.findWagerByProviderExternal(providerId, externalTransactionId),
      findProcessedReversal: async (referenceTransactionId) =>
        this.findWagerBy((state) => isProcessedReversal(state) && state.referenceTransactionId === referenceTransactionId),
      claimPendingReference: async (transactionId, now) => {
        const state = this.wagers.get(transactionId);
        const transaction = state && WagerTransaction.rehydrate(state);
        return transaction?.isAwaitingReference(now) ? transaction : undefined;
      },
      ledgerEntries: async (walletId) => this.ledgerOf(walletId).map((entry) => WalletLedgerEntry.rehydrate(entry)),
      save: async (write) => this.save(write),
    };
  }

  private save(write: WagerWrite): void {
    const hook = this.beforeNextSave;
    this.beforeNextSave = undefined;
    hook?.();

    this.assertUnique(write);

    const { transaction, wallet, entry, inbox, outbox } = write;
    if (wallet) this.wallets.set(wallet.id, wallet.toState());
    this.wagers.set(transaction.id, transaction.toState());
    if (entry) this.ledger.push(entry.toState());
    if (inbox) this.inbox.set(inboxKey(inbox.consumerName, inbox.messageId), inbox.toState());
    for (const message of outbox) this.outbox.set(message.id, message.toState());
  }

  private assertUnique({ transaction, inbox }: WagerWrite): void {
    const candidate = transaction.toState();

    for (const stored of this.wagers.values()) {
      if (stored.id === candidate.id) continue;
      if (stored.idempotencyKey === candidate.idempotencyKey) throw new UniqueViolationError("idempotency_key");
      if (
        candidate.providerId !== undefined &&
        stored.providerId === candidate.providerId &&
        stored.externalTransactionId === candidate.externalTransactionId
      ) {
        throw new UniqueViolationError("provider_external");
      }
      if (isProcessedReversal(stored) && isProcessedReversal(candidate) && stored.referenceTransactionId === candidate.referenceTransactionId) {
        throw new UniqueViolationError("reversal");
      }
    }

    if (inbox && this.inbox.has(inboxKey(inbox.consumerName, inbox.messageId))) throw new UniqueViolationError("inbox");
  }

  private readWallet(walletId: string): Wallet | undefined {
    if (this.corruptWallets.has(walletId)) throw new CorruptStateError();

    const state = this.wallets.get(walletId);
    return state && Wallet.rehydrate(state);
  }

  private findWagerBy(match: (state: WagerTransactionState) => boolean): WagerTransaction | undefined {
    const state = [...this.wagers.values()].find(match);
    return state && WagerTransaction.rehydrate(state);
  }

  private ledgerOf(walletId: string): LedgerEntryState[] {
    return this.ledger.filter((entry) => entry.walletId === walletId).sort(compareEntries);
  }

  private async lock(walletId: string): Promise<() => void> {
    const previous = this.locks.get(walletId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(walletId, previous.then(() => current));
    await previous;

    return release;
  }
}

function inboxKey(consumerName: string, messageId: string): string {
  return `${consumerName}:${messageId}`;
}

function isProcessedReversal(state: WagerTransactionState): boolean {
  const reversal = state.kind === WagerTransactionKind.Refund || state.kind === WagerTransactionKind.Rollback;
  return reversal && state.status === WagerTransactionStatus.Processed;
}

function compareEntries(left: LedgerCursor, right: LedgerCursor): number {
  const time = left.createdAt.getTime() - right.createdAt.getTime();
  if (time !== 0) return time;
  if (left.id === right.id) return 0;

  return left.id < right.id ? -1 : 1;
}
