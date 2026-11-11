export const CLOCK = Symbol("Clock");

export const DEFAULT_BACKOFF_CAP_SECONDS = 60;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function backoffMs(attempt: number, capSeconds: number): number {
  return Math.min(2 ** (attempt - 1), capSeconds) * 1000;
}
