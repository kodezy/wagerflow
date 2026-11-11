import { InvalidMoneyError, ValidationCode, ValidationError } from "./errors";
import { canonicalHash } from "./hash";
import { Money } from "./money";
import { WagerTransaction, WagerTransactionKind } from "./transaction";

export interface WagerRequest {
  idempotencyKey: string;
  payloadHash: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WalletRequest {
  playerId: string;
  initialBalance: Money;
}

export function parseWagerRequest(body: unknown, idempotencyKey: unknown): WagerRequest {
  const key = parseIdempotencyKey(idempotencyKey);
  const fields = asRecord(body);

  const business = {
    providerId: text(fields, "providerId"),
    externalTransactionId: text(fields, "externalTransactionId"),
    playerId: text(fields, "playerId"),
    walletId: text(fields, "walletId"),
    roundId: text(fields, "roundId"),
    gameId: text(fields, "gameId"),
    kind: parseKind(fields.kind),
    money: parseMoney(fields.money, "money"),
    referenceExternalTransactionId: optionalText(fields, "referenceExternalTransactionId"),
  };
  WagerTransaction.assertCreatable(business);

  return { ...business, idempotencyKey: key, payloadHash: canonicalHash({ ...business, money: business.money.toJSON() }) };
}

export function parseWalletRequest(body: unknown): WalletRequest {
  const fields = asRecord(body);

  return { playerId: text(fields, "playerId"), initialBalance: parseMoney(fields.initialBalance, "initialBalance") };
}

const MAX_ID_LENGTH = 255;
const KINDS = new Set<string>(Object.values(WagerTransactionKind));

function parseIdempotencyKey(value: unknown): string {
  if (value === undefined || value === null || value === "") throw new ValidationError(ValidationCode.IdempotencyKeyRequired, "idempotencyKey");
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH) throw new ValidationError(ValidationCode.InvalidPayload, "idempotencyKey");

  return value;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError(ValidationCode.InvalidPayload, "body");

  return body as Record<string, unknown>;
}

function text(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new ValidationError(ValidationCode.InvalidPayload, name);
  }

  return value;
}

function optionalText(fields: Record<string, unknown>, name: string): string | undefined {
  if (fields[name] === undefined || fields[name] === null) return undefined;

  return text(fields, name);
}

function parseKind(value: unknown): WagerTransactionKind {
  if (typeof value !== "string" || !KINDS.has(value)) throw new ValidationError(ValidationCode.InvalidPayload, "kind");

  return value as WagerTransactionKind;
}

function parseMoney(value: unknown, field: string): Money {
  try {
    return Money.from(value as { amount: string; currency: string });
  } catch (error) {
    if (error instanceof InvalidMoneyError) throw new ValidationError(ValidationCode.InvalidMoney, field);
    throw error;
  }
}
