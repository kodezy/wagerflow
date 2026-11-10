export class Loop {
  private stopping?: AbortController;
  private running?: Promise<void>;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: (signal: AbortSignal) => Promise<void>,
  ) {}

  start(): void {
    if (this.running) return;

    this.stopping = new AbortController();
    this.running = this.run(this.stopping.signal);
  }

  async stop(graceMs: number): Promise<void> {
    this.stopping?.abort();

    await Promise.race([this.running ?? Promise.resolve(), Bun.sleep(graceMs)]);
    this.running = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch {
        if (signal.aborted) return;
      }

      await Bun.sleep(this.intervalMs);
    }
  }
}
