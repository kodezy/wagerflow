import { backoffMs, DEFAULT_BACKOFF_CAP_SECONDS } from "./clock";
import { FailureCode, InvalidTransactionStateError, ValidationCode, ValidationError } from "./errors";
import { LedgerDirection } from "./ledger";
import type { Money } from "./money";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface ReferencePolicy {
  maxMisses: number;
  capSeconds: number;
}

export const DEFAULT_REFERENCE_POLICY: ReferencePolicy = { maxMisses: 12, capSeconds: DEFAULT_BACKOFF_CAP_SECONDS };

export interface WagerTransactionState {
  id: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceAttempts: number;
  nextAttemptAt?: Date;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt: Date;
}

export type CreationRules = Pick<CreateWagerTransactionProps, "kind" | "money" | "referenceExternalTransactionId">;

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextAttemptAt = state.nextAttemptAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertCreatable(props);

    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, referenceAttempts: 0 });
  }

  static assertCreatable(rules: CreationRules): void {
    const reference = rules.referenceExternalTransactionId;

    if (rules.kind === WagerTransactionKind.Opening) throw new ValidationError(ValidationCode.OpeningNotAccepted, "kind");
    if (REVERSALS.has(rules.kind) && reference === undefined) {
      throw new ValidationError(ValidationCode.InvalidPayload, "referenceExternalTransactionId");
    }
    if (UNREFERENCED.has(rules.kind) && reference !== undefined) {
      throw new ValidationError(ValidationCode.InvalidPayload, "referenceExternalTransactionId");
    }
    if (rules.kind !== WagerTransactionKind.Loss && !rules.money.isPositive()) {
      throw new ValidationError(ValidationCode.InvalidMoney, "money");
    }
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    return new WagerTransaction({
      id: props.id,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.assertOpen("markProcessed");

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this.close(at);
  }

  markPendingReference(observedBalance: Money, at: Date, policy = DEFAULT_REFERENCE_POLICY): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference on ${this._status}`);
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
    this._referenceAttempts = 1;
    this._nextAttemptAt = new Date(at.getTime() + backoffMs(1, policy.capSeconds));
  }

  recordReferenceMiss(observedBalance: Money, at: Date, policy = DEFAULT_REFERENCE_POLICY): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`recordReferenceMiss on ${this._status}`);
    }

    this._referenceAttempts += 1;

    if (this._referenceAttempts >= policy.maxMisses) {
      this.reject(FailureCode.ReferenceNotFound, observedBalance, at);
      return;
    }

    this._nextAttemptAt = new Date(at.getTime() + backoffMs(this._referenceAttempts, policy.capSeconds));
  }

  reject(code: FailureCode, observedBalance: Money | undefined, at: Date): void {
    this.assertOpen("reject");

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this.close(at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertOpen("fail");

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._observedBalance = undefined;
    this.close(at);
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  isAwaitingReference(now: Date): boolean {
    return this._status === WagerTransactionStatus.PendingReference && this._nextAttemptAt !== undefined && this._nextAttemptAt <= now;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSALS.has(this.kind);
  }

  acceptsReference(reference: WagerTransaction): boolean {
    return ACCEPTED_REFERENCES[this.kind].includes(reference.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new InvalidTransactionStateError("ROLLBACK needs its reference");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS has no ledger direction");
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      observedBalance: this._observedBalance,
      referenceAttempts: this._referenceAttempts,
      nextAttemptAt: this._nextAttemptAt,
    };
  }

  private assertOpen(transition: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(`${transition} on ${this._status}`);
  }

  private close(at: Date): void {
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }
}

const REVERSALS = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
const UNREFERENCED = new Set([WagerTransactionKind.Bet, WagerTransactionKind.Loss]);
const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);

const ACCEPTED_REFERENCES: Record<WagerTransactionKind, WagerTransactionKind[]> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Loss]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};
