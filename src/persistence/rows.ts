import { EntitySchema } from "@mikro-orm/core";

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  balanceCurrency: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerRow {
  id: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  observedBalanceAmount: string | null;
  observedBalanceCurrency: string | null;
  referenceAttempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  currency: string;
  createdAt: Date;
}

export interface InboxRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

const decimal = { type: "decimal", precision: 19, scale: 2, runtimeType: "string" } as const;
const optionalDecimal = { ...decimal, nullable: true } as const;

export const WalletRow = new EntitySchema<WalletRow>({
  name: "WalletRow",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string" },
    currency: { type: "string" },
    balanceAmount: decimal,
    balanceCurrency: { type: "string" },
    version: { type: "integer" },
    createdAt: { type: "datetime" },
    updatedAt: { type: "datetime" },
  },
});

export const WagerRow = new EntitySchema<WagerRow>({
  name: "WagerRow",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", nullable: true },
    externalTransactionId: { type: "string", nullable: true },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string" },
    walletId: { type: "string" },
    playerId: { type: "string" },
    roundId: { type: "string", nullable: true },
    gameId: { type: "string", nullable: true },
    kind: { type: "string" },
    amount: decimal,
    currency: { type: "string" },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    observedBalanceAmount: optionalDecimal,
    observedBalanceCurrency: { type: "string", nullable: true },
    referenceAttempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", nullable: true },
    createdAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});

export const LedgerRow = new EntitySchema<LedgerRow>({
  name: "LedgerRow",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: decimal,
    balanceBefore: decimal,
    balanceAfter: decimal,
    currency: { type: "string" },
    createdAt: { type: "datetime" },
  },
});

export const InboxRow = new EntitySchema<InboxRow>({
  name: "InboxRow",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string" },
    receivedAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});

export const OutboxRow = new EntitySchema<OutboxRow>({
  name: "OutboxRow",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "json" },
    occurredAt: { type: "datetime" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", nullable: true },
    publishedAt: { type: "datetime", nullable: true },
  },
});
