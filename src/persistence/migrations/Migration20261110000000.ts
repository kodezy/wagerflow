import { Migration } from "@mikro-orm/migrations";

export class Migration20261110000000 extends Migration {
  override async up(): Promise<void> {
    for (const statement of UP) this.addSql(statement);
  }

  override async down(): Promise<void> {
    for (const statement of DOWN) this.addSql(statement);
  }
}

const UP = [
  `create table wallets (
    id uuid primary key,
    player_id text not null,
    currency char(3) not null,
    balance_amount numeric(19, 2) not null,
    balance_currency char(3) not null,
    version integer not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint wallets_player_currency_unique unique (player_id, currency),
    constraint wallets_player_id_length check (char_length(player_id) between 1 and 255),
    constraint wallets_balance_non_negative check (balance_amount >= 0),
    constraint wallets_balance_currency check (balance_currency = currency),
    constraint wallets_version_positive check (version >= 1)
  )`,
  `create table wager_transactions (
    id uuid primary key,
    provider_id text,
    external_transaction_id text,
    idempotency_key text not null,
    payload_hash char(64) not null,
    wallet_id text not null,
    player_id text not null,
    round_id text,
    game_id text,
    kind text not null,
    amount numeric(19, 2) not null,
    currency char(3) not null,
    reference_external_transaction_id text,
    reference_transaction_id uuid references wager_transactions (id),
    status text not null,
    failure_code text,
    observed_balance_amount numeric(19, 2),
    observed_balance_currency char(3),
    reference_attempts integer not null default 0,
    next_attempt_at timestamptz,
    created_at timestamptz not null,
    processed_at timestamptz,
    constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
    constraint wager_transactions_kind check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
    constraint wager_transactions_status check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
    constraint wager_transactions_amount check (amount > 0 or (kind = 'LOSS' and amount = 0)),
    constraint wager_transactions_observed_balance check (
      (observed_balance_amount is null) = (observed_balance_currency is null) and coalesce(observed_balance_amount, 0) >= 0
    ),
    constraint wager_transactions_opening_shape check (
      (kind = 'OPENING') = (provider_id is null)
      and (kind = 'OPENING') = (external_transaction_id is null)
      and (kind = 'OPENING') = (round_id is null)
      and (kind = 'OPENING') = (game_id is null)
      and (kind <> 'OPENING' or (status = 'PROCESSED' and reference_external_transaction_id is null))
    ),
    constraint wager_transactions_reference_shape check (
      case kind
        when 'REFUND' then reference_external_transaction_id is not null
        when 'ROLLBACK' then reference_external_transaction_id is not null
        when 'WIN' then true
        else reference_external_transaction_id is null
      end
    ),
    constraint wager_transactions_reference_link check (
      reference_transaction_id is null or (status = 'PROCESSED' and reference_external_transaction_id is not null)
    ),
    constraint wager_transactions_failure_shape check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
    constraint wager_transactions_pending_shape check (
      (status = 'PENDING_REFERENCE') = (next_attempt_at is not null) and (status = 'PENDING_REFERENCE') = (processed_at is null)
    )
  )`,
  `create unique index wager_transactions_provider_external_unique on wager_transactions (provider_id, external_transaction_id)
    where provider_id is not null and external_transaction_id is not null`,
  `create unique index wager_transactions_reversal_unique on wager_transactions (reference_transaction_id)
    where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`,
  `create index wager_transactions_pending_due on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE'`,
  `create index wager_transactions_wallet on wager_transactions (wallet_id, created_at)`,
  `create table wallet_ledger_entries (
    id uuid primary key,
    wallet_id uuid not null references wallets (id),
    transaction_id uuid not null references wager_transactions (id),
    direction text not null,
    amount numeric(19, 2) not null,
    balance_before numeric(19, 2) not null,
    balance_after numeric(19, 2) not null,
    currency char(3) not null,
    created_at timestamptz not null,
    constraint wallet_ledger_entries_transaction_wallet_unique unique (transaction_id, wallet_id),
    constraint wallet_ledger_entries_direction check (direction in ('DEBIT', 'CREDIT')),
    constraint wallet_ledger_entries_amount_positive check (amount > 0),
    constraint wallet_ledger_entries_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
    constraint wallet_ledger_entries_balanced check (
      balance_after = case direction when 'CREDIT' then balance_before + amount else balance_before - amount end
    )
  )`,
  `create index wallet_ledger_entries_cursor on wallet_ledger_entries (wallet_id, created_at, id)`,
  `create function wallet_ledger_entries_append_only() returns trigger language plpgsql as $$
    begin
      raise exception 'wallet_ledger_entries is append-only' using errcode = 'P0001';
    end
  $$`,
  `create trigger wallet_ledger_entries_no_update_delete before update or delete on wallet_ledger_entries
    for each row execute function wallet_ledger_entries_append_only()`,
  `create trigger wallet_ledger_entries_no_truncate before truncate on wallet_ledger_entries
    for each statement execute function wallet_ledger_entries_append_only()`,
  `create table inbox_messages (
    consumer_name text not null,
    message_id text not null,
    payload_hash char(64) not null,
    received_at timestamptz not null,
    processed_at timestamptz,
    constraint inbox_messages_pkey primary key (consumer_name, message_id)
  )`,
  `create table outbox_messages (
    id uuid primary key,
    aggregate_id text not null,
    event_type text not null,
    payload jsonb not null,
    occurred_at timestamptz not null,
    attempts integer not null default 0,
    next_attempt_at timestamptz,
    published_at timestamptz,
    constraint outbox_messages_attempts check (attempts >= 0),
    constraint outbox_messages_schedule check ((published_at is null) = (next_attempt_at is not null))
  )`,
  `create index outbox_messages_due on outbox_messages (next_attempt_at) where published_at is null`,
];

const DOWN = [
  `drop table outbox_messages`,
  `drop table inbox_messages`,
  `drop table wallet_ledger_entries`,
  `drop function wallet_ledger_entries_append_only()`,
  `drop table wager_transactions`,
  `drop table wallets`,
];
