import { useEffect, useSyncExternalStore } from "react";
import {
  loadWorkspaceGitSummary,
  type WorkspaceGitOverview,
  type WorkspaceGitSummary,
} from "../runtime";
import { workspaceGitChangeMonitor } from "./workspace-git-change-monitor";
import { createWorkspaceRootKey } from "./workspace-management-model";

let latestWorkspaceGitSequence = 0;

export const nextWorkspaceGitSequence = (): number =>
  ++latestWorkspaceGitSequence;

export interface WorkspaceGitSummaryEntry {
  summary: WorkspaceGitSummary | null;
  error: string | null;
  loadedAt: number;
}

interface WorkspaceGitSummaryStoreOptions {
  load: (workspaceRoot: string) => Promise<WorkspaceGitSummary | null>;
  now: () => number;
  schedule: (task: () => void) => void;
  maxConcurrent: number;
  staleMs: number;
}

export interface WorkspaceGitSummaryStore {
  get: (workspaceRoot: string) => WorkspaceGitSummaryEntry | undefined;
  subscribe: (listener: () => void) => () => void;
  request: (workspaceRoot: string, options?: { force?: boolean }) => void;
  publish: (
    workspaceRoot: string,
    summary: WorkspaceGitSummary | null,
    sequence?: number,
  ) => void;
}

export const createWorkspaceGitSummaryStore = ({
  load,
  now,
  schedule,
  maxConcurrent,
  staleMs,
}: WorkspaceGitSummaryStoreOptions): WorkspaceGitSummaryStore => {
  const entries = new Map<string, WorkspaceGitSummaryEntry>();
  const sequences = new Map<string, number>();
  const listeners = new Set<() => void>();
  const queue = new Map<string, string>();
  const running = new Set<string>();
  const followUps = new Map<string, string>();
  let pumpScheduled = false;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const store = (
    key: string,
    sequence: number,
    entry: WorkspaceGitSummaryEntry,
  ): void => {
    if (sequence < (sequences.get(key) ?? 0)) return;
    sequences.set(key, sequence);
    entries.set(key, entry);
    notify();
  };

  const pump = (): void => {
    pumpScheduled = false;
    for (const [key, workspaceRoot] of queue) {
      if (running.size >= maxConcurrent) return;
      queue.delete(key);
      running.add(key);
      const sequence = nextWorkspaceGitSequence();
      void load(workspaceRoot)
        .then((summary) =>
          store(key, sequence, { summary, error: null, loadedAt: now() }),
        )
        .catch((error: unknown) =>
          store(key, sequence, {
            summary: entries.get(key)?.summary ?? null,
            error: error instanceof Error ? error.message : String(error),
            loadedAt: now(),
          }),
        )
        .finally(() => {
          running.delete(key);
          const followUp = followUps.get(key);
          if (followUp !== undefined) {
            followUps.delete(key);
            queue.set(key, followUp);
          }
          if (queue.size > 0) schedulePump();
        });
    }
  };

  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    schedule(pump);
  };

  return {
    get: (workspaceRoot) => entries.get(createWorkspaceRootKey(workspaceRoot)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: (workspaceRoot, options = {}) => {
      const key = createWorkspaceRootKey(workspaceRoot);
      const entry = entries.get(key);
      if (queue.has(key)) return;
      if (running.has(key)) {
        if (options.force) followUps.set(key, workspaceRoot);
        return;
      }
      if (!options.force && entry && now() - entry.loadedAt < staleMs) return;
      queue.set(key, workspaceRoot);
      schedulePump();
    },
    publish: (
      workspaceRoot,
      summary,
      sequence = nextWorkspaceGitSequence(),
    ) => {
      store(createWorkspaceRootKey(workspaceRoot), sequence, {
        summary,
        error: null,
        loadedAt: now(),
      });
    },
  };
};

export const workspaceGitSummaryFromOverview = (
  overview: WorkspaceGitOverview,
): WorkspaceGitSummary => ({
  branch: overview.branch,
  detached: overview.detached,
  ...(overview.upstream ? { upstream: overview.upstream } : {}),
  ahead: overview.ahead,
  behind: overview.behind,
  changes: overview.totalChanges,
  conflicts: overview.conflictedCount,
});

const SUMMARY_STALE_MS = 20_000;

export const workspaceGitSummaryStore = createWorkspaceGitSummaryStore({
  load: loadWorkspaceGitSummary,
  now: () => Date.now(),
  schedule: (task) => {
    window.setTimeout(task, 0);
  },
  maxConcurrent: 2,
  staleMs: SUMMARY_STALE_MS,
});

workspaceGitChangeMonitor.subscribe((workspaceRoot) =>
  workspaceGitSummaryStore.request(workspaceRoot, { force: true }),
);

export const useWorkspaceGitSummary = (
  workspaceRoot: string | null,
): WorkspaceGitSummaryEntry | undefined => {
  const entry = useSyncExternalStore(workspaceGitSummaryStore.subscribe, () =>
    workspaceRoot ? workspaceGitSummaryStore.get(workspaceRoot) : undefined,
  );
  useEffect(() => {
    if (!workspaceRoot) return;
    workspaceGitSummaryStore.request(workspaceRoot);
    const unwatch = workspaceGitChangeMonitor.watch(workspaceRoot);
    const refresh = (): void => {
      if (document.visibilityState === "visible") {
        workspaceGitSummaryStore.request(workspaceRoot);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unwatch();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workspaceRoot]);
  return entry;
};
