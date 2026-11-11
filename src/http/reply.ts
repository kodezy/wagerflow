import { ValidationCode, ValidationError } from "../wagering/errors";
import { WagerTransactionStatus } from "../wagering/transaction";
import type { WagerOutcome } from "../wagering/apply";

export function correlationOf(headers: Record<string, unknown>): string {
  const value = headers["x-correlation-id"];
  return typeof value === "string" && value.length > 0 ? value : Bun.randomUUIDv7();
}

export function parseJson(body: unknown): unknown {
  if (typeof body !== "string" || body.length === 0) throw new ValidationError(ValidationCode.InvalidPayload, "body");

  try {
    return JSON.parse(body);
  } catch {
    throw new ValidationError(ValidationCode.InvalidPayload, "body");
  }
}

export function outcomeStatus(outcome: WagerOutcome): number {
  if (outcome.status === WagerTransactionStatus.PendingReference) return 202;
  if (outcome.status === WagerTransactionStatus.Failed) return 500;
  return 200;
}
