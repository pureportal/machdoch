import { useEffect, useSyncExternalStore } from "react";
import {
  loadWorkspaceGitSummary,
  type WorkspaceGitOverview,
  type WorkspaceGitSummary,
} from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";

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
  publish: (workspaceRoot: string, summary: WorkspaceGitSummary | null) => void;
}

export const createWorkspaceGitSummaryStore = ({
  load,
  now,
  schedule,
  maxConcurrent,
  staleMs,
}: WorkspaceGitSummaryStoreOptions): WorkspaceGitSummaryStore => {
  const entries = new Map<string, WorkspaceGitSummaryEntry>();
  const listeners = new Set<() => void>();
  const queue = new Map<string, string>();
  const running = new Set<string>();
  let pumpScheduled = false;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const store = (key: string, entry: WorkspaceGitSummaryEntry): void => {
    entries.set(key, entry);
    notify();
  };

  const pump = (): void => {
    pumpScheduled = false;
    for (const [key, workspaceRoot] of queue) {
      if (running.size >= maxConcurrent) return;
      queue.delete(key);
      running.add(key);
      void load(workspaceRoot)
        .then((summary) =>
          store(key, { summary, error: null, loadedAt: now() }),
        )
        .catch((error: unknown) =>
          store(key, {
            summary: entries.get(key)?.summary ?? null,
            error: error instanceof Error ? error.message : String(error),
            loadedAt: now(),
          }),
        )
        .finally(() => {
          running.delete(key);
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
      if (running.has(key) || queue.has(key)) return;
      if (!options.force && entry && now() - entry.loadedAt < staleMs) return;
      queue.set(key, workspaceRoot);
      schedulePump();
    },
    publish: (workspaceRoot, summary) => {
      store(createWorkspaceRootKey(workspaceRoot), {
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

export const useWorkspaceGitSummary = (
  workspaceRoot: string | null,
): WorkspaceGitSummaryEntry | undefined => {
  const entry = useSyncExternalStore(workspaceGitSummaryStore.subscribe, () =>
    workspaceRoot ? workspaceGitSummaryStore.get(workspaceRoot) : undefined,
  );
  useEffect(() => {
    if (!workspaceRoot) return;
    workspaceGitSummaryStore.request(workspaceRoot);
    const refresh = (): void => {
      if (document.visibilityState === "visible") {
        workspaceGitSummaryStore.request(workspaceRoot);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workspaceRoot]);
  return entry;
};
