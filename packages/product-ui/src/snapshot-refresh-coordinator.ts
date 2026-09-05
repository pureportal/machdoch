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
  private activeController: AbortController | null = null;

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

  // Background polling must not invalidate a slow response on every timer tick.
  poll(signal?: AbortSignal): Promise<void> {
    if (this.disposed || signal?.aborted) return Promise.resolve();
    return this.inFlight ? this.completion : this.request(signal);
  }

  dispose(): void {
    this.disposed = true;
    this.refreshQueued = false;
    this.activeController?.abort();
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
      const controller = new AbortController();
      this.activeController = controller;
      const abort = (): void => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();

      try {
        const snapshot = await this.options.fetchSnapshot(controller.signal);
        if (this.isCurrentRequest(requestId, signal)) {
          this.options.onSnapshot(snapshot);
        }
      } catch (reason) {
        if (this.isCurrentRequest(requestId, signal)) {
          this.options.onError(reason);
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        if (this.activeController === controller) this.activeController = null;
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
