import type { Clock } from "../../src/wagering/clock";

export class FakeClock implements Clock {
  constructor(private current = new Date("2026-11-10T12:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
