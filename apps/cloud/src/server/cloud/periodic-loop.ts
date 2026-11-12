export const periodicLoopDelays = {
  busy: 1000,
  idle: 5000,
  firstRetry: 2000,
  maximumRetry: 60_000,
} as const;

export class CloudPeriodicLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking: Promise<void> | undefined;
  private retryDelay: number = periodicLoopDelays.firstRetry;
  private started = false;
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly work: () => Promise<number>,
    private readonly batchSize: number,
  ) {}

  start(): void {
    if (this.closed) throw new Error(`${this.name} is closed.`);
    if (this.started) return;
    this.started = true;
    this.wait(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.ticking;
  }

  private wait(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref();
  }

  private tick(): void {
    this.ticking = this.work()
      .then(
        (processed) => {
          this.retryDelay = periodicLoopDelays.firstRetry;
          return processed >= this.batchSize
            ? periodicLoopDelays.busy
            : periodicLoopDelays.idle;
        },
        (error: unknown) => {
          console.error(
            `${this.name} failed`,
            error instanceof Error ? error.name : "Unknown error",
          );
          const delay = this.retryDelay;
          this.retryDelay = Math.min(
            periodicLoopDelays.maximumRetry,
            delay * 2,
          );
          return delay;
        },
      )
      .then((delay) => {
        this.ticking = undefined;
        this.wait(delay);
      });
  }
}
