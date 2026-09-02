export interface SnapshotRefreshCoordinatorOptions<Snapshot> {
  fetchSnapshot: (signal?: AbortSignal) => Promise<Snapshot>;
  onSnapshot: (snapshot: Snapshot) => void;
  onError: (reason: unknown) => void;
}

export class SnapshotRefreshCoordinator<Snapshot> {
  private disposed = false;
  private inFlight = false;
  private refreshQueued = false;
  private latestRequestId = 0;
  private latestSignal: AbortSignal | undefined;
  private completion: Promise<void> = Promise.resolve();
  private resolveCompletion: (() => void) | null = null;

  constructor(
    private readonly options: SnapshotRefreshCoordinatorOptions<Snapshot>,
  ) {}

  request(signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) return Promise.resolve();

    this.latestRequestId += 1;
    this.latestSignal = signal;
    this.refreshQueued = true;
    this.start();
    return this.completion;
  }

  dispose(): void {
    this.disposed = true;
    this.refreshQueued = false;
    this.complete();
  }

  private start(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    this.completion = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
    void this.run();
  }

  private async run(): Promise<void> {
    while (this.refreshQueued && !this.disposed) {
      this.refreshQueued = false;
      const requestId = this.latestRequestId;
      const signal = this.latestSignal;

      try {
        const snapshot = await this.options.fetchSnapshot(signal);
        if (this.isCurrentRequest(requestId, signal)) {
          this.options.onSnapshot(snapshot);
        }
      } catch (reason) {
        if (this.isCurrentRequest(requestId, signal)) {
          this.options.onError(reason);
        }
      }

      if (requestId === this.latestRequestId) {
        this.complete();
      }
    }

    this.inFlight = false;
  }

  private isCurrentRequest(requestId: number, signal?: AbortSignal): boolean {
    return (
      !this.disposed && !signal?.aborted && requestId === this.latestRequestId
    );
  }

  private complete(): void {
    this.resolveCompletion?.();
    this.resolveCompletion = null;
  }
}
