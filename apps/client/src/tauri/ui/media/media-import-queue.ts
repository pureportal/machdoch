export interface MediaImportJob {
  id: string;
  label: string;
  status: "queued" | "importing" | "completed" | "failed";
  resourceId: string | null;
  error: string | null;
}

export class MediaImportQueue {
  private jobs: readonly MediaImportJob[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly tasks = new Map<string, () => Promise<string>>();
  private running = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly MediaImportJob[] => this.jobs;

  hasPendingWork(): boolean {
    return this.jobs.some((job) => job.status !== "completed");
  }

  enqueue(label: string, execute: () => Promise<string>): void {
    const id = crypto.randomUUID();
    this.tasks.set(id, execute);
    this.jobs = [
      ...this.jobs,
      { id, label, status: "queued", resourceId: null, error: null },
    ];
    this.emit();
    void this.pump();
  }

  retry(id: string): void {
    if (!this.jobs.some((job) => job.id === id && job.status === "failed"))
      return;
    this.update(id, { status: "queued", error: null });
    void this.pump();
  }

  dismiss(id: string): void {
    if (this.jobs.some((job) => job.id === id && job.status === "importing"))
      return;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    this.tasks.delete(id);
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let next: MediaImportJob | undefined;
      while ((next = this.jobs.find((job) => job.status === "queued"))) {
        const execute = this.tasks.get(next.id);
        if (!execute) throw new Error("The import task is missing.");
        this.update(next.id, { status: "importing" });
        try {
          const resourceId = await execute();
          this.tasks.delete(next.id);
          this.update(next.id, { status: "completed", resourceId });
        } catch (error: unknown) {
          this.update(next.id, {
            status: "failed",
            error:
              error instanceof Error
                ? error.message
                : typeof error === "object" &&
                    error !== null &&
                    "message" in error
                  ? String(error.message)
                  : "Import failed. Check the file and available storage, then retry.",
          });
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
