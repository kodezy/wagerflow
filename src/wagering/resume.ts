import { decideOrFail, failWager, lockWallet, outcomeOf, settleWager, type WagerOutcome, type WalletLock, type WriteContext } from "./apply";
import type { Clock } from "./clock";
import type { DueReference, WagerWrite, WageringStore, WalletSession } from "./store";
import { DEFAULT_REFERENCE_POLICY, WagerTransactionStatus, type ReferencePolicy, type WagerTransaction } from "./transaction";

export type ResumeResult =
  | { type: "skipped" }
  | { type: "waiting"; transaction: WagerTransaction }
  | { type: "decided"; outcome: WagerOutcome; transaction: WagerTransaction };

export class ResumePending {
  constructor(
    private readonly store: WageringStore,
    private readonly clock: Clock,
    private readonly policy: ReferencePolicy = DEFAULT_REFERENCE_POLICY,
  ) {}

  execute(due: DueReference): Promise<ResumeResult> {
    return this.store.inWallet(due.walletId, async (session) => {
      const lock = await lockWallet(session, due.walletId);
      const at = this.clock.now();
      const transaction = await session.claimPendingReference(due.transactionId, at);
      if (!transaction) return { type: "skipped" };

      const context: WriteContext = { at, events: { correlationId: transaction.id, occurredAt: at }, policy: this.policy, isNew: false };
      const write = await decideOrFail(transaction, context, (pending) => this.decide(session, lock, pending, context));
      await session.save(write);

      if (write.transaction.status === WagerTransactionStatus.PendingReference) return { type: "waiting", transaction: write.transaction };
      return { type: "decided", outcome: outcomeOf(write.transaction, false), transaction: write.transaction };
    });
  }

  private async decide(session: WalletSession, lock: WalletLock, transaction: WagerTransaction, context: WriteContext): Promise<WagerWrite> {
    if (lock.state !== "ready") return failWager(transaction, context);

    return settleWager(session, transaction, lock.wallet, context);
  }
}
