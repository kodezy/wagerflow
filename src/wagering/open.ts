import type { Clock } from "./clock";
import { ConflictCode } from "./errors";
import { WagerTransactionProcessed, WalletBalanceChanged } from "./events";
import { canonicalHash } from "./hash";
import { LedgerDirection, WalletLedgerEntry } from "./ledger";
import { Money } from "./money";
import { OutboxMessage } from "./outbox";
import type { WalletRequest } from "./request";
import { UniqueViolationError, type WageringStore, type WalletWrite } from "./store";
import { WagerTransaction, WagerTransactionKind } from "./transaction";
import { Wallet } from "./wallet";

export type OpenWalletResult = { type: "opened"; wallet: Wallet } | { type: "conflict"; code: ConflictCode.DuplicateWallet };

export class OpenWallet {
  constructor(
    private readonly store: WageringStore,
    private readonly clock: Clock,
  ) {}

  async execute(request: WalletRequest, correlationId: string): Promise<OpenWalletResult> {
    const at = this.clock.now();
    const wallet = Wallet.open({ id: Bun.randomUUIDv7(), playerId: request.playerId, initialBalance: request.initialBalance, at });
    const write = wallet.balance.isPositive() ? withOpening(wallet, correlationId, at) : { wallet, outbox: [] };

    try {
      await this.store.openWallet(write);
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "player_currency") {
        return { type: "conflict", code: ConflictCode.DuplicateWallet };
      }
      throw error;
    }

    return { type: "opened", wallet };
  }
}

function withOpening(wallet: Wallet, correlationId: string, at: Date): WalletWrite {
  const money = wallet.balance;
  const transaction = WagerTransaction.opening({
    id: Bun.randomUUIDv7(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    money,
    payloadHash: canonicalHash({ kind: WagerTransactionKind.Opening, playerId: wallet.playerId, walletId: wallet.id, money: money.toJSON() }),
    createdAt: at,
  });
  const entry = WalletLedgerEntry.create({
    id: Bun.randomUUIDv7(),
    walletId: wallet.id,
    transactionId: transaction.id,
    direction: LedgerDirection.Credit,
    money,
    balanceBefore: Money.zero(money.currency),
    balanceAfter: money,
    createdAt: at,
  });

  transaction.markProcessed(undefined, wallet.balance, at);

  const context = { correlationId, occurredAt: at };
  const outbox = [WagerTransactionProcessed.from(transaction, context), WalletBalanceChanged.from(wallet, entry, context)].map((event) =>
    OutboxMessage.enqueue(event),
  );

  return { wallet, opening: { transaction, entry }, outbox };
}
