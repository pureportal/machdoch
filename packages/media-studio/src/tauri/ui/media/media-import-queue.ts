export interface MediaImportJob {
  id: string;
  label: string;
  status:
    | "queued"
    | "downloading"
    | "importing"
    | "completed"
    | "failed"
    | "cancelled";
  resourceId: string | null;
  error: string | null;
  downloadKey?: string;
  received?: number;
  total?: number;
  warning?: string | null;
  cancelling?: boolean;
}

export interface MediaImportTaskContext {
  signal: AbortSignal;
  update: (
    patch: Pick<
      Partial<MediaImportJob>,
      "status" | "received" | "total" | "warning"
    >,
  ) => void;
}

export class MediaImportQueue {
  private jobs: readonly MediaImportJob[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly tasks = new Map<
    string,
    (context: MediaImportTaskContext) => Promise<string>
  >();
  private readonly controllers = new Map<string, AbortController>();
  private running = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly MediaImportJob[] => this.jobs;

  hasPendingWork(): boolean {
    return this.jobs.some(
      (job) => !["completed", "cancelled"].includes(job.status),
    );
  }

  enqueue(
    label: string,
    execute: (context: MediaImportTaskContext) => Promise<string>,
    downloadKey?: string,
  ): void {
    if (
      downloadKey &&
      this.jobs.some(
        (job) =>
          job.downloadKey === downloadKey &&
          !["failed", "cancelled"].includes(job.status),
      )
    )
      return;
    const id = crypto.randomUUID();
    this.tasks.set(id, execute);
    this.jobs = [
      ...this.jobs,
      {
        id,
        label,
        status: "queued",
        resourceId: null,
        error: null,
        downloadKey,
      },
    ];
    this.emit();
    void this.pump();
  }

  retry(id: string): void {
    const job = this.jobs.find(
      (job) => job.id === id && job.status === "failed",
    );
    if (
      !job ||
      (job.downloadKey &&
        this.jobs.some(
          (other) =>
            other.id !== id &&
            other.downloadKey === job.downloadKey &&
            !["failed", "cancelled"].includes(other.status),
        ))
    )
      return;
    this.update(id, {
      status: "queued",
      error: null,
      cancelling: false,
      received: 0,
      warning: null,
    });
    void this.pump();
  }

  dismiss(id: string): void {
    if (
      this.jobs.some(
        (job) =>
          job.id === id && ["importing", "downloading"].includes(job.status),
      )
    )
      return;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    this.tasks.delete(id);
    this.emit();
  }

  cancel(id: string): void {
    const job = this.jobs.find((item) => item.id === id);
    if (job?.status === "queued") {
      this.tasks.delete(id);
      this.update(id, { status: "cancelled" });
    } else if (job?.status === "downloading") {
      this.update(id, { cancelling: true });
      this.controllers.get(id)?.abort();
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let next: MediaImportJob | undefined;
      while ((next = this.jobs.find((job) => job.status === "queued"))) {
        const execute = this.tasks.get(next.id);
        if (!execute) throw new Error("The import task is missing.");
        const id = next.id;
        const controller = new AbortController();
        this.controllers.set(id, controller);
        this.update(id, {
          status: next.downloadKey ? "downloading" : "importing",
        });
        try {
          const resourceId = await execute({
            signal: controller.signal,
            update: (patch) => this.update(id, patch),
          });
          this.tasks.delete(next.id);
          this.update(next.id, { status: "completed", resourceId });
        } catch (error: unknown) {
          this.update(next.id, {
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: controller.signal.aborted
              ? null
              : error instanceof Error
                ? error.message
                : typeof error === "object" &&
                    error !== null &&
                    "message" in error
                  ? String(error.message)
                  : "Import failed. Check the file and available storage, then retry.",
          });
          if (controller.signal.aborted) this.tasks.delete(id);
        } finally {
          this.controllers.delete(id);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private update(id: string, patch: Partial<MediaImportJob>): void {
    this.jobs = this.jobs.map((job) =>
      job.id === id ? { ...job, ...patch } : job,
    );
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const mediaImportQueue = new MediaImportQueue();
