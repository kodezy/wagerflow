export enum FailureCode {
  InsufficientBalance = "INSUFFICIENT_BALANCE",
  ReversalInsufficientBalance = "REVERSAL_INSUFFICIENT_BALANCE",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceKindMismatch = "REFERENCE_KIND_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceScopeMismatch = "REFERENCE_SCOPE_MISMATCH",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  PermanentInfrastructure = "PERMANENT_INFRASTRUCTURE",
}

export enum ConflictCode {
  IdempotencyPayloadConflict = "IDEMPOTENCY_PAYLOAD_CONFLICT",
  DuplicateExternalTransaction = "DUPLICATE_EXTERNAL_TRANSACTION",
  DuplicateWallet = "DUPLICATE_WALLET",
}

export enum ValidationCode {
  InvalidPayload = "INVALID_PAYLOAD",
  InvalidMoney = "INVALID_MONEY",
  IdempotencyKeyRequired = "IDEMPOTENCY_KEY_REQUIRED",
  OpeningNotAccepted = "OPENING_NOT_ACCEPTED",
}

export class InvalidMoneyError extends Error {
  override readonly name = "InvalidMoneyError";

  constructor(readonly field: "amount" | "currency") {
    super(`invalid money ${field}`);
  }
}

export class CurrencyMismatchError extends Error {
  override readonly name = "CurrencyMismatchError";

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency ${actual} differs from ${expected}`);
  }
}

export class InsufficientBalanceError extends Error {
  override readonly name = "InsufficientBalanceError";

  constructor(readonly walletId: string) {
    super(`wallet ${walletId} cannot go negative`);
  }
}

export class UnbalancedLedgerError extends Error {
  override readonly name = "UnbalancedLedgerError";
}

export class InvalidTransactionStateError extends Error {
  override readonly name = "InvalidTransactionStateError";
}

export class EventSerializationError extends Error {
  override readonly name = "EventSerializationError";

  constructor(readonly eventType: string) {
    super(`${eventType} cannot be serialized`);
  }
}

export class ValidationError extends Error {
  override readonly name = "ValidationError";

  constructor(
    readonly code: ValidationCode,
    readonly field: string,
  ) {
    super(`${code} at ${field}`);
  }
}
