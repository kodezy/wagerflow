import { Global, Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";

import { WAGERING_STORE } from "../wagering/store";
import { createOrm } from "./orm";
import { PostgresWageringStore } from "./store";

export const ORM = Symbol("MikroORM");

@Global()
@Module({})
export class PersistenceModule {
  static register(databaseUrl: string): DynamicModule {
    return {
      module: PersistenceModule,
      providers: [
        { provide: ORM, useFactory: () => createOrm(databaseUrl) },
        { provide: WAGERING_STORE, useFactory: (orm: MikroORM) => new PostgresWageringStore(orm), inject: [ORM] },
        OrmShutdown,
      ],
      exports: [WAGERING_STORE, ORM],
    };
  }
}

@Injectable()
class OrmShutdown implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
