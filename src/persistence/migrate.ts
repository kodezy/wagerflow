import { loadConfig } from "../config";
import { createOrm } from "./orm";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") throw new Error("usage: bun src/persistence/migrate.ts up|down");

const orm = await createOrm(loadConfig(process.env).databaseUrl);

try {
  if (direction === "up") await orm.migrator.up();
  else await orm.migrator.down();
} finally {
  await orm.close();
}
