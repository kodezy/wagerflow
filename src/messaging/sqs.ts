import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";

import type { Config, SqsConfig } from "../config";
import { sha256 } from "../wagering/hash";
import type { OutboxMessage } from "../wagering/outbox";

export interface SqsDelivery {
  receiptHandle: string;
  messageGroupId: string;
  sqsMessageId: string;
  body: string;
  receiveCount: number;
}

export class SqsGateway {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: Pick<SqsConfig, "wagerQueueUrl" | "wagerDlqUrl" | "eventsQueueUrl">,
  ) {}

  ping(): Promise<void> {
    return this.attributes(this.queues.wagerQueueUrl, ["QueueArn"]).then(() => undefined);
  }

  receive(signal?: AbortSignal): Promise<SqsDelivery[]> {
    return this.receiveFrom(this.queues.wagerQueueUrl, 10, signal);
  }

  async receiveFrom(queueUrl: string, waitSeconds = 2, signal?: AbortSignal): Promise<SqsDelivery[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
      }),
      { abortSignal: signal },
    );

    return (response.Messages ?? []).flatMap((message) => {
      if (!message.ReceiptHandle || !message.Body || !message.MessageId) return [];

      return [
        {
          receiptHandle: message.ReceiptHandle,
          messageGroupId: message.Attributes?.MessageGroupId ?? "unparsed",
          sqsMessageId: message.MessageId,
          body: message.Body,
          receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
        },
      ];
    });
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.deleteFrom(this.queues.wagerQueueUrl, receiptHandle);
  }

  async deleteFrom(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  async release(receiptHandle: string): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.wagerQueueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }),
    );
  }

  async sendToDlq(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queues.wagerDlqUrl,
        MessageBody: body,
        MessageGroupId: fifoId(groupId),
        MessageDeduplicationId: fifoId(deduplicationId),
      }),
    );
  }

  async publishEvent(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queues.eventsQueueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: fifoId(message.aggregateId),
        MessageDeduplicationId: fifoId(`${message.id}:${message.attempts}`),
      }),
    );
  }

  async sendWager(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queues.wagerQueueUrl,
        MessageBody: body,
        MessageGroupId: fifoId(groupId),
        MessageDeduplicationId: fifoId(deduplicationId),
      }),
    );
  }

  async dlqDepth(): Promise<number> {
    const attributes = await this.attributes(this.queues.wagerDlqUrl, ["ApproximateNumberOfMessages"]);
    return Number(attributes.ApproximateNumberOfMessages ?? 0);
  }

  private async attributes(queueUrl: string, names: Array<"QueueArn" | "ApproximateNumberOfMessages">): Promise<Record<string, string>> {
    const response = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: names }));
    return response.Attributes ?? {};
  }
}

export function sqsClient(config: Config): SQSClient {
  const options: SQSClientConfig = {
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
    maxAttempts: 2,
  };

  return new SQSClient(options);
}

export interface QueueNames {
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
}

export async function createQueues(
  client: SQSClient,
  options: { prefix: string; visibilityTimeout: number; maxReceiveCount: number },
): Promise<QueueNames> {
  const dlq = await ensureQueue(client, `${options.prefix}wager-transactions-dlq.fifo`, {
    FifoQueue: "true",
    ContentBasedDeduplication: "false",
    VisibilityTimeout: String(options.visibilityTimeout),
  });
  const arn = (await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["QueueArn"] }))).Attributes?.QueueArn;
  if (!arn) throw new Error("wager DLQ has no ARN");

  const wager = await ensureQueue(client, `${options.prefix}wager-transactions.fifo`, {
    FifoQueue: "true",
    ContentBasedDeduplication: "false",
    VisibilityTimeout: String(options.visibilityTimeout),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: options.maxReceiveCount }),
  });
  const events = await ensureQueue(client, `${options.prefix}integration-events.fifo`, {
    FifoQueue: "true",
    ContentBasedDeduplication: "false",
    VisibilityTimeout: String(options.visibilityTimeout),
  });

  return { wagerQueueUrl: wager, wagerDlqUrl: dlq, eventsQueueUrl: events };
}

export function fifoId(value: string): string {
  return /^[\w.-]{1,128}$/.test(value) ? value : sha256(value);
}

async function ensureQueue(client: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  try {
    const created = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    if (!created.QueueUrl) throw new Error(`queue ${name} has no url`);
    return created.QueueUrl;
  } catch (error) {
    const nameOf = error instanceof Error ? error.name : "";
    if (nameOf !== "QueueNameExists" && nameOf !== "QueueAlreadyExists") throw error;

    const existing = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!existing.QueueUrl) throw new Error(`queue ${name} has no url`);
    return existing.QueueUrl;
  }
}
