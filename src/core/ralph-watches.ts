import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DurableSmartScheduler,
  getUserSchedulerStatePath,
  type ScheduledTriggerEventResult,
} from "./scheduler.js";
import {
  getUserRalphDirectory,
  acquireRalphFileMutationLock,
  type RalphFlowScope,
} from "./ralph.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";
import {
  normalizeRalphWatchId,
  normalizeRalphWatchInput,
} from "./_helpers/normalize-ralph-watch-input.helper.js";
import {
  watchRootMatchesPath,
} from "./_helpers/watch-root-matches-path.helper.js";
import {
  scanRalphWatchFiles,
  waitForStableRalphWatchFile,
  type RalphWatchFileSnapshot,
} from "./_helpers/scan-ralph-watch-files.helper.js";
import { createRalphWatchSchedulerJobInput } from "./_helpers/create-ralph-watch-scheduler-job-input.helper.js";
import { createRalphWatchTriggerEventInput } from "./_helpers/create-ralph-watch-trigger-event-input.helper.js";
import {
  RALPH_WATCH_FILE_NAME,
  RALPH_WATCH_SCHEMA,
  RALPH_WATCH_SCHEMA_VERSION,
  createEmptyRalphWatchState,
} from "./_helpers/create-empty-ralph-watch-state.helper.js";
import { parseRalphWatchState } from "./_helpers/parse-ralph-watch-state.helper.js";
import { collectRalphWatchSnapshotEvents } from "./_helpers/collect-ralph-watch-snapshot-events.helper.js";
import { createRalphWatchFileEvent } from "./_helpers/create-ralph-watch-file-event.helper.js";

export { normalizeRalphWatchInput } from "./_helpers/normalize-ralph-watch-input.helper.js";
export { watchRootMatchesPath } from "./_helpers/watch-root-matches-path.helper.js";
export { createRalphWatchSchedulerJobInput } from "./_helpers/create-ralph-watch-scheduler-job-input.helper.js";
export { createUserRalphWatchScheduler } from "./_helpers/create-user-ralph-watch-scheduler.helper.js";
export { getRalphWatchIgnoredRoots } from "./_helpers/get-ralph-watch-ignored-roots.helper.js";
export {
  RALPH_WATCH_FILE_NAME,
  RALPH_WATCH_SCHEMA,
  RALPH_WATCH_SCHEMA_VERSION,
  createEmptyRalphWatchState,
} from "./_helpers/create-empty-ralph-watch-state.helper.js";

export type RalphWatchEventType = "created" | "changed" | "deleted" | "renamed";

export interface RalphWatchRoot {
  path: string;
  workspaceRoot?: string;
  include: string[];
  exclude: string[];
}

export interface RalphWatchFlowReference {
  scope: RalphFlowScope;
  id: string;
}

export interface RalphWatchPermissionProfile {
  allowedRoots: string[];
  allowCommands: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  allowMcpTools: boolean;
}

export interface RalphWatchDefinition {
  id: string;
  enabled: boolean;
  name?: string;
  flow: RalphWatchFlowReference;
  executionWorkspaceRoot: string;
  runLogScope?: RalphFlowScope;
  roots: RalphWatchRoot[];
  events: RalphWatchEventType[];
  params: Record<string, string>;
  permissions: RalphWatchPermissionProfile;
  debounceMs: number;
  stabilityMs: number;
  pollIntervalMs: number;
  cooldownMs?: number;
  maxEventsPerWindow: {
    maxEvents: number;
    windowMs: number;
  };
  maxTransitions?: number;
  concurrencyLimit: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface RalphWatchState {
  schema: typeof RALPH_WATCH_SCHEMA;
  schemaVersion: typeof RALPH_WATCH_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  watches: RalphWatchDefinition[];
}

export interface RalphWatchInput {
  id?: string;
  enabled?: boolean;
  name?: string;
  flow: Partial<RalphWatchFlowReference> & { id: string };
  executionWorkspaceRoot?: string;
  runLogScope?: RalphFlowScope;
  roots: Array<{
    path: string;
    workspaceRoot?: string;
    include?: string[];
    exclude?: string[];
  }>;
  events?: RalphWatchEventType[];
  params?: Record<string, string>;
  permissions?: Partial<RalphWatchPermissionProfile>;
  debounceMs?: number;
  stabilityMs?: number;
  pollIntervalMs?: number;
  cooldownMs?: number;
  maxEventsPerWindow?: Partial<RalphWatchDefinition["maxEventsPerWindow"]>;
  maxTransitions?: number;
  concurrencyLimit?: number;
  allowDangerousRoots?: boolean;
}

export interface RalphWatchFileEvent {
  type: RalphWatchEventType;
  path: string;
  rootPath: string;
  relativePath: string;
  size?: number;
  mtimeMs?: number;
  isDirectory?: boolean;
  occurredAt: number;
}

export interface RalphWatchServiceOptions {
  scheduler: DurableSmartScheduler;
  onError?: (watch: RalphWatchDefinition, error: unknown) => void | Promise<void>;
  onEvent?: (
    watch: RalphWatchDefinition,
    event: RalphWatchFileEvent,
    result: ScheduledTriggerEventResult,
  ) => void | Promise<void>;
}

interface WatchHandle {
  stop(): void;
}

export const getRalphWatchStatePath = (): string => {
  return join(getUserRalphDirectory(), RALPH_WATCH_FILE_NAME);
};

export const loadRalphWatchState = async (): Promise<RalphWatchState> => {
  const path = getRalphWatchStatePath();

  if (!existsSync(path)) {
    return createEmptyRalphWatchState();
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

  return parseRalphWatchState(parsed, path);
};

const writeRalphWatchStateUnlocked = async (
  state: RalphWatchState,
): Promise<string> => {
  const path = getRalphWatchStatePath();
  await writeJsonAtomically(path, state);
  return path;
};

const withRalphWatchStateMutation = async <Result>(
  mutate: () => Promise<Result>,
): Promise<Result> => {
  const path = getRalphWatchStatePath();
  let lastError: unknown;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const lock = await acquireRalphFileMutationLock(
        path,
        `ralph-watch:${process.pid}:${randomUUID()}`,
      );
      try {
        return await mutate();
      } finally {
        await lock.release();
      }
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("Ralph mutation lease is active for") ||
        attempt === 79
      ) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const saveRalphWatchState = async (
  state: RalphWatchState,
): Promise<string> => {
  return withRalphWatchStateMutation(() => writeRalphWatchStateUnlocked(state));
};

export const listRalphWatches = async (): Promise<RalphWatchDefinition[]> => {
  return (await loadRalphWatchState()).watches;
};

export const upsertRalphWatch = async (
  input: RalphWatchInput,
): Promise<RalphWatchDefinition> => {
  return withRalphWatchStateMutation(async () => {
    const state = await loadRalphWatchState();
    const id = normalizeRalphWatchId(input.id);
    const existing = state.watches.find((watch) => watch.id === id);
    const watchDefinition = await normalizeRalphWatchInput(input, existing);
    const nextWatches = existing
      ? state.watches.map((watch) =>
          watch.id === watchDefinition.id ? watchDefinition : watch,
        )
      : [...state.watches, watchDefinition];

    await writeRalphWatchStateUnlocked({
      ...state,
      updatedAt: new Date().toISOString(),
      watches: nextWatches.sort((left, right) => left.id.localeCompare(right.id)),
    });

    return watchDefinition;
  });
};

export const deleteRalphWatch = async (id: string): Promise<RalphWatchDefinition> => {
  return withRalphWatchStateMutation(async () => {
    const normalizedId = normalizeRalphWatchId(id);
    const state = await loadRalphWatchState();
    const match = state.watches.find((watch) => watch.id === normalizedId);

    if (!match) {
      throw new Error(`Ralph watch not found: ${id}`);
    }

    await writeRalphWatchStateUnlocked({
      ...state,
      updatedAt: new Date().toISOString(),
      watches: state.watches.filter((watch) => watch.id !== normalizedId),
    });

    return match;
  });
};

export const syncRalphWatchSchedulerJobs = async (
  scheduler = new DurableSmartScheduler({ statePath: getUserSchedulerStatePath() }),
): Promise<void> => {
  const watches = await listRalphWatches();
  const activeDedupeKeys = new Set<string>();

  for (const watchDefinition of watches) {
    activeDedupeKeys.add(`ralph-watch:${watchDefinition.id}`);
    const job = await scheduler.upsertJob(
      createRalphWatchSchedulerJobInput(watchDefinition),
    );

    if (watchDefinition.enabled && job.status === "paused") {
      await scheduler.resumeJob(job.id);
    } else if (!watchDefinition.enabled && job.status === "active") {
      await scheduler.pauseJob(job.id);
    }
  }

  const jobs = await scheduler.listJobs();

  for (const job of jobs) {
    if (
      job.dedupeKey?.startsWith("ralph-watch:") &&
      !activeDedupeKeys.has(job.dedupeKey)
    ) {
      await scheduler.deleteJob(job.id);
    }
  }
};

export const emitRalphWatchEvent = async (
  scheduler: DurableSmartScheduler,
  watchDefinition: RalphWatchDefinition,
  event: RalphWatchFileEvent,
): Promise<ScheduledTriggerEventResult> => {
  return scheduler.recordEventAndEnqueueRuns(
    createRalphWatchTriggerEventInput(watchDefinition, event),
  );
};

export class RalphWatchService {
  private readonly scheduler: DurableSmartScheduler;
  private readonly onError:
    | ((watch: RalphWatchDefinition, error: unknown) => void | Promise<void>)
    | undefined;
  private readonly onEvent:
    | ((
        watch: RalphWatchDefinition,
        event: RalphWatchFileEvent,
        result: ScheduledTriggerEventResult,
      ) => void | Promise<void>)
    | undefined;
  private handles: WatchHandle[] = [];
  private stopped = true;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: RalphWatchServiceOptions) {
    this.scheduler = options.scheduler;
    this.onError = options.onError;
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    await syncRalphWatchSchedulerJobs(this.scheduler);
    const watches = (await listRalphWatches()).filter((watchDefinition) =>
      watchDefinition.enabled,
    );

    this.stopped = false;

    for (const watchDefinition of watches) {
      for (const root of watchDefinition.roots) {
        this.handles.push(await this.startRoot(watchDefinition, root));
      }
    }
  }

  stop(): void {
    this.stopped = true;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }

    this.debounceTimers.clear();

    for (const handle of this.handles) {
      handle.stop();
    }

    this.handles = [];
  }

  private async startRoot(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
  ): Promise<WatchHandle> {
    if (process.platform === "win32" || process.platform === "darwin") {
      try {
        const watcher = watch(root.path, { recursive: true }, (eventName, fileName) => {
          const candidatePath = fileName
            ? resolve(root.path, String(fileName))
            : root.path;
          void this.queueNativeEvent(watchDefinition, root, eventName, candidatePath);
        });

        watcher.on("error", (error) => {
          void this.reportError(watchDefinition, error);
        });

        return {
          stop: () => watcher.close(),
        };
      } catch (error) {
        await this.reportError(watchDefinition, error);
      }
    }

    return this.startPollingRoot(watchDefinition, root);
  }

  private async startPollingRoot(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
  ): Promise<WatchHandle> {
    let previous = await scanRalphWatchFiles(root);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollingStopped = false;

    const scheduleNextPoll = (): void => {
      if (this.stopped || pollingStopped) {
        return;
      }

      timer = setTimeout(() => {
        void poll();
      }, watchDefinition.pollIntervalMs);
    };
    const poll = async (): Promise<void> => {
      if (this.stopped || pollingStopped) {
        return;
      }

      try {
        const current = await scanRalphWatchFiles(root);
        const now = Date.now();

        for (const event of collectRalphWatchSnapshotEvents(previous, current)) {
          this.queueEvent(
            watchDefinition,
            root,
            event.eventType,
            event.path,
            event.snapshot,
            now,
          );
        }

        previous = current;
      } catch (error) {
        await this.reportError(watchDefinition, error);
      } finally {
        scheduleNextPoll();
      }
    };

    scheduleNextPoll();

    return {
      stop: () => {
        pollingStopped = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      },
    };
  }

  private async queueNativeEvent(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
    eventName: string,
    candidatePath: string,
  ): Promise<void> {
    if (!watchRootMatchesPath(root, candidatePath)) {
      return;
    }

    const snapshot = await waitForStableRalphWatchFile(
      candidatePath,
      watchDefinition.stabilityMs,
    );
    const eventType: RalphWatchEventType =
      eventName === "rename"
        ? snapshot
          ? "created"
          : "deleted"
        : "changed";

    this.queueEvent(watchDefinition, root, eventType, candidatePath, snapshot, Date.now());
  }

  private queueEvent(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
    eventType: RalphWatchEventType,
    path: string,
    snapshot: RalphWatchFileSnapshot | undefined,
    occurredAt: number,
  ): void {
    if (!watchDefinition.events.includes(eventType)) {
      return;
    }

    const key = `${watchDefinition.id}:${eventType}:${path}`;
    const existing = this.debounceTimers.get(key);

    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.emit(watchDefinition, root, eventType, path, snapshot, occurredAt);
    }, watchDefinition.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  private async emit(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
    eventType: RalphWatchEventType,
    path: string,
    snapshot: RalphWatchFileSnapshot | undefined,
    occurredAt: number,
  ): Promise<void> {
    if (this.stopped || !watchRootMatchesPath(root, path)) {
      return;
    }

    const event = createRalphWatchFileEvent({
      root,
      eventType,
      path,
      snapshot,
      occurredAt,
    });

    try {
      const result = await emitRalphWatchEvent(this.scheduler, watchDefinition, event);
      await this.scheduler.runQueuedRuns({ maxRuns: 1 });
      await this.onEvent?.(watchDefinition, event, result);
    } catch (error) {
      await this.reportError(watchDefinition, error);
    }
  }

  private async reportError(
    watchDefinition: RalphWatchDefinition,
    error: unknown,
  ): Promise<void> {
    await this.onError?.(watchDefinition, error);
  }
}
