import type {
  ImageRecipeSettings,
  MediaAssetRecord,
  MediaErrorDetail,
  MediaGenerationTarget,
  MediaModelAddonSelection,
  MediaImageOutputBranch,
  MediaRunDetail,
  MediaRuntimeRunStatus,
  MediaVideoRecipeSettings,
} from "../../../core/media/contracts.js";
import { normalizeMediaError } from "./media-runtime.js";

export type MediaGenerationMode = "basic" | "advanced";

export interface MediaGenerationRecipeSnapshot {
  schemaVersion: 1;
  mode: MediaGenerationMode;
  target: MediaGenerationTarget;
  flowId: string;
  flowName: string;
  flowRevisionId: string;
  flowRevisionNumber: number;
  planId: string;
  prompt: string;
  modelId: string | null;
  modelLabel: string;
  modelAddons: MediaModelAddonSelection[];
  outputBranches: MediaImageOutputBranch[];
  imageSettings: ImageRecipeSettings | null;
  videoSettings: MediaVideoRecipeSettings | null;
  resultDestination: "assets";
}

export interface MediaGenerationQueueJob {
  id: string;
  runId: string;
  status: MediaRuntimeRunStatus;
  label: string;
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: number;
  currentStep: string;
  recipe: MediaGenerationRecipeSnapshot;
  assets: readonly MediaAssetRecord[];
  error: string | null;
  failure: MediaErrorDetail | null;
}

interface MediaGenerationQueueTask {
  execute: () => Promise<MediaRunDetail>;
  cancel?: () => Promise<MediaRunDetail | void>;
}

interface MediaGenerationQueueOptions {
  readRunDetail?: (runId: string) => Promise<MediaRunDetail>;
  cancelRun?: (runId: string) => Promise<MediaRunDetail | void>;
  now?: () => Date;
  pollIntervalMs?: number;
  historyLimit?: number;
}

export interface EnqueueMediaGenerationInput {
  runId: string;
  recipe: MediaGenerationRecipeSnapshot;
  execute: () => Promise<MediaRunDetail>;
  cancel?: () => Promise<MediaRunDetail | void>;
}

const ACTIVE_STATUSES: ReadonlySet<MediaRuntimeRunStatus> = new Set([
  "queued",
  "running",
  "canceling",
]);

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const immutableClone = <T>(value: T): T => deepFreeze(structuredClone(value));

const mediaTypeLabel = (target: MediaGenerationTarget): string =>
  target === "svg"
    ? "SVG"
    : `${target[0]?.toLocaleUpperCase()}${target.slice(1)}`;

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim())
    return error.message.trim();
  return "Generation failed.";
};

const isTerminalStatus = (status: MediaRuntimeRunStatus): boolean =>
  !ACTIVE_STATUSES.has(status);

export class MediaGenerationQueue {
  private readonly readRunDetail?: MediaGenerationQueueOptions["readRunDetail"];
  private readonly cancelRun?: MediaGenerationQueueOptions["cancelRun"];
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly historyLimit: number;
  private readonly listeners = new Set<() => void>();
  private readonly tasks = new Map<string, MediaGenerationQueueTask>();
  private jobs: readonly MediaGenerationQueueJob[] = Object.freeze([]);
  private activeJobId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollSequence = 0;

  constructor(options: MediaGenerationQueueOptions = {}) {
    this.readRunDetail = options.readRunDetail;
    this.cancelRun = options.cancelRun;
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.historyLimit = options.historyLimit ?? 50;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly MediaGenerationQueueJob[] => this.jobs;

  enqueue(input: EnqueueMediaGenerationInput): MediaGenerationQueueJob {
    if (this.jobs.some((job) => job.runId === input.runId)) {
      throw new Error(`Generation run ${input.runId} is already queued.`);
    }
    const recipe = immutableClone(input.recipe);
    const submittedAt = this.now().toISOString();
    const job = immutableClone<MediaGenerationQueueJob>({
      id: input.runId,
      runId: input.runId,
      status: "queued",
      label: `${mediaTypeLabel(recipe.target)} generation`,
      submittedAt,
      startedAt: null,
      completedAt: null,
      progress: 0,
      currentStep: "Waiting in queue",
      recipe,
      assets: [],
      error: null,
      failure: null,
    });
    this.tasks.set(input.runId, {
      execute: input.execute,
      ...(input.cancel ? { cancel: input.cancel } : {}),
    });
    this.replaceJobs([...this.jobs, job]);
    void this.pump();
    return job;
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job || isTerminalStatus(job.status)) return;
    if (job.status === "queued") {
      this.tasks.delete(job.id);
      this.patchJob(job.id, {
        status: "canceled",
        currentStep: "Canceled",
        completedAt: this.now().toISOString(),
      });
      return;
    }
    if (job.status === "canceling") return;
    this.patchJob(job.id, {
      status: "canceling",
      currentStep: "Canceling generation",
    });
    const cancelTask = this.tasks.get(job.id)?.cancel;
    if (!cancelTask && !this.cancelRun) return;
    try {
      const detail = cancelTask
        ? await cancelTask()
        : await this.cancelRun?.(job.runId);
      if (detail) this.applyDetail(job.id, detail);
    } catch (error: unknown) {
      this.patchJob(job.id, {
        status: "running",
        currentStep: errorMessage(error),
      });
    }
  }

  getJob(runId: string): MediaGenerationQueueJob | null {
    return this.jobs.find((job) => job.runId === runId) ?? null;
  }

  getActiveJob(): MediaGenerationQueueJob | null {
    return (
      this.jobs.find(
        (job) => job.id === this.activeJobId && ACTIVE_STATUSES.has(job.status),
      ) ?? null
    );
  }

  updateProgress(runId: string, progress: number, currentStep: string): void {
    const job = this.getJob(runId);
    if (!job || isTerminalStatus(job.status)) return;
    this.patchJob(runId, {
      progress: Math.min(1, Math.max(0, progress)),
      currentStep,
    });
  }

  dispose(): void {
    this.stopPolling();
    this.listeners.clear();
  }

  private async pump(): Promise<void> {
    if (this.activeJobId !== null) return;
    const next = this.jobs.find(
      (job) => job.status === "queued" && this.tasks.has(job.id),
    );
    if (!next) return;
    const task = this.tasks.get(next.id);
    if (!task) return;
    this.activeJobId = next.id;
    this.patchJob(next.id, {
      status: "running",
      startedAt: this.now().toISOString(),
      currentStep: `Starting ${next.recipe.target} generation`,
    });
    this.startPolling(next.id);
    try {
      const detail = await task.execute();
      this.applyDetail(next.id, detail);
      if (ACTIVE_STATUSES.has(detail.status)) {
        this.stopPolling();
        await this.waitForTerminal(next.id);
      }
    } catch (error: unknown) {
      const current = this.getJob(next.id);
      if (current?.status === "canceling" || current?.status === "canceled") {
        this.patchJob(next.id, {
          status: "canceled",
          completedAt: this.now().toISOString(),
          currentStep: "Canceled",
        });
        return;
      }
      const detail = await this.readDetailAfterFailure(next.runId);
      if (detail) {
        this.applyDetail(next.id, detail);
      } else {
        const failure = normalizeMediaError(error, "media_generation_queue");
        this.patchJob(next.id, {
          status: "failed",
          completedAt: this.now().toISOString(),
          currentStep: "Generation failed",
          error: errorMessage(error),
          failure,
        });
      }
    } finally {
      this.stopPolling();
      this.tasks.delete(next.id);
      this.activeJobId = null;
      void this.pump();
    }
  }

  private startPolling(jobId: string): void {
    if (!this.readRunDetail) return;
    const pollSequence = ++this.pollSequence;
    const poll = async (): Promise<void> => {
      if (
        this.pollSequence !== pollSequence ||
        this.activeJobId !== jobId ||
        !this.readRunDetail
      ) {
        return;
      }
      try {
        const detail = await this.readRunDetail(jobId);
        this.applyDetail(jobId, detail);
      } catch {
        if (this.pollSequence !== pollSequence || this.activeJobId !== jobId) {
          return;
        }
      }
      if (this.pollSequence === pollSequence && this.activeJobId === jobId) {
        this.pollTimer = setTimeout(() => void poll(), this.pollIntervalMs);
      }
    };
    this.pollTimer = setTimeout(() => void poll(), 0);
  }

  private async waitForTerminal(jobId: string): Promise<void> {
    if (!this.readRunDetail) {
      throw new Error(
        "Generation returned before completion and cannot be monitored.",
      );
    }
    let consecutiveReadFailures = 0;
    while (
      this.activeJobId === jobId &&
      ACTIVE_STATUSES.has(this.getJob(jobId)?.status ?? "failed")
    ) {
      await new Promise<void>((resolve) => {
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          resolve();
        }, this.pollIntervalMs);
      });
      if (this.activeJobId !== jobId) return;
      try {
        this.applyDetail(jobId, await this.readRunDetail(jobId));
      } catch {
        consecutiveReadFailures += 1;
        if (consecutiveReadFailures >= 8) {
          throw new Error("Generation status became unavailable.");
        }
        continue;
      }
      consecutiveReadFailures = 0;
    }
  }

  private stopPolling(): void {
    this.pollSequence += 1;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async readDetailAfterFailure(
    runId: string,
  ): Promise<MediaRunDetail | null> {
    if (!this.readRunDetail) return null;
    try {
      return await this.readRunDetail(runId);
    } catch {
      return null;
    }
  }

  private applyDetail(jobId: string, detail: MediaRunDetail): void {
    const current = this.getJob(jobId);
    if (!current) return;
    if (
      isTerminalStatus(current.status) &&
      ACTIVE_STATUSES.has(detail.status)
    ) {
      return;
    }
    const preserveCurrentStatus =
      (current.status === "running" && detail.status === "queued") ||
      (current.status === "canceling" &&
        (detail.status === "queued" || detail.status === "running"));
    const status = preserveCurrentStatus ? current.status : detail.status;
    const completedAt = isTerminalStatus(status) ? detail.updatedAt : null;
    this.patchJob(jobId, {
      status,
      progress: Math.max(current.progress, detail.progress),
      currentStep: preserveCurrentStatus
        ? current.currentStep
        : detail.currentStep,
      completedAt,
      assets: detail.assets,
      error: detail.error,
      failure: detail.failure,
    });
  }

  private patchJob(
    jobId: string,
    patch: Partial<MediaGenerationQueueJob>,
  ): void {
    this.replaceJobs(
      this.jobs.map((job) =>
        job.id === jobId
          ? immutableClone({ ...job, ...patch, recipe: job.recipe })
          : job,
      ),
    );
  }

  private replaceJobs(next: readonly MediaGenerationQueueJob[]): void {
    const terminal = next.filter((job) => isTerminalStatus(job.status));
    const excess = Math.max(0, terminal.length - this.historyLimit);
    const removed = new Set(terminal.slice(0, excess).map((job) => job.id));
    this.jobs = Object.freeze(next.filter((job) => !removed.has(job.id)));
    for (const listener of this.listeners) listener();
  }
}
