import { backoffMs, DEFAULT_BACKOFF_CAP_SECONDS } from "./clock";
import { EventSerializationError, InvalidTransactionStateError } from "./errors";
import type { IntegrationEvent } from "./events";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, serialize(event), event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`outbox ${this.id} is already published`);

    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date, capSeconds = DEFAULT_BACKOFF_CAP_SECONDS): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`outbox ${this.id} is already published`);

    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffMs(this._attempts, capSeconds));
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }
}

function serialize(event: IntegrationEvent<unknown>): Readonly<Record<string, unknown>> {
  try {
    return Object.freeze(JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>);
  } catch {
    throw new EventSerializationError(event.eventType);
  }
}
