import {
  decideOrFail,
  failWager,
  lockWallet,
  outcomeOf,
  rejectWager,
  settleWager,
  type WagerOutcome,
  type WalletLock,
  type WriteContext,
} from "./apply";
import type { Clock } from "./clock";
import { ConflictCode, FailureCode } from "./errors";
import { InboxMessage } from "./inbox";
import type { WagerRequest } from "./request";
import { CorruptStateError, UniqueViolationError, type WagerWrite, type WageringStore, type WalletSession } from "./store";
import { DEFAULT_REFERENCE_POLICY, WagerTransaction, type ReferencePolicy } from "./transaction";

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitCommand {
  request: WagerRequest;
  correlationId: string;
  inbox?: InboxReceipt;
}

export type SubmitResult =
  | { type: "outcome"; outcome: WagerOutcome; transaction: WagerTransaction }
  | { type: "conflict"; code: ConflictCode.IdempotencyPayloadConflict | ConflictCode.DuplicateExternalTransaction; transactionId: string }
  | { type: "inbox-replay"; outcome: WagerOutcome; transaction: WagerTransaction }
  | { type: "inbox-conflict" };

export class SubmitWager {
  constructor(
    private readonly store: WageringStore,
    private readonly clock: Clock,
    private readonly policy: ReferencePolicy = DEFAULT_REFERENCE_POLICY,
  ) {}

  execute(command: SubmitCommand): Promise<SubmitResult> {
    return this.store.inWallet(command.request.walletId, async (session) => {
      try {
        return await this.attempt(session, command);
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
        return this.attempt(session, command);
      }
    });
  }

  private async attempt(session: WalletSession, command: SubmitCommand): Promise<SubmitResult> {
    const lock = await lockWallet(session, command.request.walletId);
    const duplicate = await this.findDuplicate(session, command);
    if (duplicate) return duplicate;

    const at = this.clock.now();
    const context: WriteContext = {
      at,
      events: { correlationId: command.correlationId, occurredAt: at },
      policy: this.policy,
      isNew: true,
      inbox: command.inbox && receiveInbox(command.inbox, at),
    };
    const transaction = createTransaction(command.request, at);
    const write = await decideOrFail(transaction, context, (pending) => this.decide(session, command.request, lock, pending, context));

    await session.save(write);
    return { type: "outcome", outcome: outcomeOf(write.transaction, false), transaction: write.transaction };
  }

  private async findDuplicate(session: WalletSession, { request, inbox }: SubmitCommand): Promise<SubmitResult | undefined> {
    if (inbox) {
      const received = await session.findInbox(inbox.consumerName, inbox.messageId);
      if (received?.matches(inbox.payloadHash)) return this.inboxReplay(session, request);
      if (received) return { type: "inbox-conflict" };
    }

    const sameKey = await session.findWagerByIdempotencyKey(request.idempotencyKey);
    if (sameKey?.matchesPayload(request.payloadHash)) return { type: "outcome", outcome: outcomeOf(sameKey, true), transaction: sameKey };
    if (sameKey) return { type: "conflict", code: ConflictCode.IdempotencyPayloadConflict, transactionId: sameKey.id };

    const sameExternal = await session.findWagerByProviderExternal(request.providerId, request.externalTransactionId);
    if (sameExternal) return { type: "conflict", code: ConflictCode.DuplicateExternalTransaction, transactionId: sameExternal.id };

    return undefined;
  }

  private async inboxReplay(session: WalletSession, request: WagerRequest): Promise<SubmitResult> {
    const stored = await session.findWagerByIdempotencyKey(request.idempotencyKey);
    if (!stored) throw new CorruptStateError("inbox row without its wager");

    return { type: "inbox-replay", outcome: outcomeOf(stored, true), transaction: stored };
  }

  private async decide(
    session: WalletSession,
    request: WagerRequest,
    lock: WalletLock,
    transaction: WagerTransaction,
    context: WriteContext,
  ): Promise<WagerWrite> {
    if (lock.state === "unreadable") return failWager(transaction, context);
    if (lock.state === "missing" || lock.wallet.playerId !== request.playerId) {
      return rejectWager(transaction, FailureCode.WalletNotFound, undefined, context);
    }
    if (lock.wallet.currency !== request.money.currency) {
      return rejectWager(transaction, FailureCode.CurrencyMismatch, lock.wallet.balance, context);
    }

    return settleWager(session, transaction, lock.wallet, context);
  }
}

function createTransaction(request: WagerRequest, at: Date): WagerTransaction {
  return WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    providerId: request.providerId,
    externalTransactionId: request.externalTransactionId,
    idempotencyKey: request.idempotencyKey,
    payloadHash: request.payloadHash,
    walletId: request.walletId,
    playerId: request.playerId,
    roundId: request.roundId,
    gameId: request.gameId,
    kind: request.kind,
    money: request.money,
    referenceExternalTransactionId: request.referenceExternalTransactionId,
    createdAt: at,
  });
}

function receiveInbox(receipt: InboxReceipt, at: Date): InboxMessage {
  const message = InboxMessage.receive({ ...receipt, receivedAt: at });
  message.markProcessed(at);

  return message;
}
