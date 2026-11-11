import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, MikroORM } from "@mikro-orm/postgresql";

import { Migration20261110000000 } from "./migrations/Migration20261110000000";
import { InboxRow, LedgerRow, OutboxRow, WagerRow, WalletRow } from "./rows";

export function createOrm(databaseUrl: string): Promise<MikroORM> {
  return MikroORM.init(
    defineConfig({
      clientUrl: databaseUrl,
      entities: [WalletRow, WagerRow, LedgerRow, InboxRow, OutboxRow],
      extensions: [Migrator],
      migrations: {
        migrationsList: [{ name: "Migration20261110000000", class: Migration20261110000000 }],
        transactional: true,
      },
      driverOptions: { connectionTimeoutMillis: 2000 },
      debug: false,
    }),
  );
}
