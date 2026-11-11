import { expect } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

import { createOrm } from "../../src/persistence/orm";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://wagerflow:wagerflow@localhost:5432/wagerflow_test";
export const UNREACHABLE_DATABASE_URL = "postgresql://wagerflow:wagerflow@127.0.0.1:1/wagerflow";

export async function testOrm(): Promise<MikroORM> {
  const orm = await createOrm(TEST_DATABASE_URL);
  await orm.migrator.up();

  return orm;
}

export async function sql<T = Record<string, unknown>>(orm: MikroORM, query: string, params: unknown[] = []): Promise<T[]> {
  return (await orm.em.fork().execute(query, params)) as T[];
}

export async function expectLedgersMatch(orm: MikroORM): Promise<void> {
  expect(await sql(orm, DRIFT)).toEqual([]);
}

const DRIFT = `
  select w.id, w.balance_amount::text as stored,
    coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19, 2)::text as folded
  from wallets w
  left join wallet_ledger_entries l on l.wallet_id = w.id
  group by w.id
  having w.balance_amount <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`;
