import { loadConfig } from "../config";
import { createQueues, sqsClient } from "./sqs";

const config = loadConfig(process.env);
await createQueues(sqsClient(config), { prefix: "", visibilityTimeout: 30, maxReceiveCount: 5 });
