import { loadConfig } from "./config";
import { createApp } from "./app";

const config = loadConfig(process.env);
const app = await createApp(config);
await app.listen(config.port, "0.0.0.0");
