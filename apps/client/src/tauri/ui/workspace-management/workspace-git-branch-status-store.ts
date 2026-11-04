import { useEffect, useSyncExternalStore } from "react";
import {
  loadWorkspaceGitBranchStatus,
  type WorkspaceGitBranchStatus,
} from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";

export interface WorkspaceGitBranchStatusEntry {
  status: WorkspaceGitBranchStatus | null;
  error: string | null;
  loadedAt: number;
  loading: boolean;
  fetching: boolean;
}

interface BranchStatusRequest {
  workspaceRoot: string;
  branchName: string | null;
  fetch: boolean;
}

interface WorkspaceGitBranchStatusStoreOptions {
  load: (
    workspaceRoot: string,
    branchName: string | null,
    fetch: boolean,
  ) => Promise<WorkspaceGitBranchStatus>;
  now: () => number;
  schedule: (task: () => void) => void;
  maxConcurrent: number;
  staleMs: number;
}

export interface WorkspaceGitBranchStatusStore {
  get: (
    workspaceRoot: string,
    branchName: string | null,
  ) => WorkspaceGitBranchStatusEntry | undefined;
  subscribe: (listener: () => void) => () => void;
  watch: (workspaceRoot: string, branchName: string | null) => () => void;
  request: (
    workspaceRoot: string,
    branchName: string | null,
    options?: { force?: boolean; fetch?: boolean },
  ) => void;
  invalidate: (workspaceRoot: string) => void;
  isSwitching: (workspaceRoot: string) => boolean;
  setSwitching: (workspaceRoot: string, switching: boolean) => void;
}

const statusKey = (workspaceRoot: string, branchName: string | null): string =>
  `${createWorkspaceRootKey(workspaceRoot)}\n${branchName ?? ""}`;

const workspaceKeyOf = (key: string): string => key.slice(0, key.indexOf("\n"));

export const createWorkspaceGitBranchStatusStore = ({
  load,
  now,
  schedule,
  maxConcurrent,
  staleMs,
}: WorkspaceGitBranchStatusStoreOptions): WorkspaceGitBranchStatusStore => {
  const entries = new Map<string, WorkspaceGitBranchStatusEntry>();
  const listeners = new Set<() => void>();
  const queue = new Map<string, BranchStatusRequest>();
  const followUps = new Map<string, BranchStatusRequest>();
  const running = new Map<string, BranchStatusRequest>();
  const watchers = new Map<string, { request: BranchStatusRequest; count: number }>();
  const switching = new Set<string>();
  let pumpScheduled = false;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const update = (
    key: string,
    change: Partial<WorkspaceGitBranchStatusEntry>,
  ): void => {
    const current = entries.get(key) ?? {
      status: null,
      error: null,
      loadedAt: 0,
      loading: false,
      fetching: false,
    };
    entries.set(key, { ...current, ...change });
    notify();
  };

  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    schedule(pump);
  };

  const enqueue = (key: string, request: BranchStatusRequest): void => {
    queue.set(key, request);
    schedulePump();
  };

  function pump(): void {
    pumpScheduled = false;
    for (const [key, request] of queue) {
      if (running.size >= maxConcurrent) return;
      queue.delete(key);
      running.set(key, request);
      update(key, { loading: true, fetching: request.fetch });
      void load(request.workspaceRoot, request.branchName, request.fetch)
        .then((status) =>
          update(key, {
            status,
            error: null,
            loadedAt: now(),
            loading: false,
            fetching: false,
          }),
        )
        .catch((error: unknown) =>
          update(key, {
            error: error instanceof Error ? error.message : String(error),
            loadedAt: now(),
            loading: false,
            fetching: false,
          }),
        )
        .finally(() => {
          running.delete(key);
          const followUp = followUps.get(key);
          if (followUp) {
            followUps.delete(key);
            enqueue(key, followUp);
          } else if (queue.size > 0) {
            schedulePump();
          }
        });
    }
  }

  const request: WorkspaceGitBranchStatusStore["request"] = (
    workspaceRoot,
    branchName,
    { force = false, fetch = false } = {},
  ) => {
    const key = statusKey(workspaceRoot, branchName);
    const next = { workspaceRoot, branchName, fetch };
    const queued = queue.get(key);
    if (queued) {
      if (fetch && !queued.fetch) followUps.set(key, next);
      return;
    }
    if (running.has(key)) {
      if (force || fetch) {
        followUps.set(key, {
          ...next,
          fetch: fetch || followUps.get(key)?.fetch === true,
        });
      }
      return;
    }
    const entry = entries.get(key);
    if (!force && !fetch && entry && now() - entry.loadedAt < staleMs) return;
    enqueue(key, next);
  };

  return {
    get: (workspaceRoot, branchName) =>
      entries.get(statusKey(workspaceRoot, branchName)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch: (workspaceRoot, branchName) => {
      const key = statusKey(workspaceRoot, branchName);
      const watcher = watchers.get(key);
      watchers.set(key, {
        request: { workspaceRoot, branchName, fetch: false },
        count: (watcher?.count ?? 0) + 1,
      });
      request(workspaceRoot, branchName);
      return () => {
        const current = watchers.get(key);
        if (!current) return;
        if (current.count > 1) {
          watchers.set(key, { ...current, count: current.count - 1 });
        } else {
          watchers.delete(key);
        }
      };
    },
    request,
    invalidate: (workspaceRoot) => {
      const workspaceKey = createWorkspaceRootKey(workspaceRoot);
      let changed = false;
      for (const key of new Set([...entries.keys(), ...watchers.keys()])) {
        if (workspaceKeyOf(key) !== workspaceKey) continue;
        const pending = watchers.get(key)?.request ?? running.get(key);
        if (pending) {
          request(pending.workspaceRoot, pending.branchName, { force: true });
        } else if (!queue.has(key) && entries.delete(key)) {
          changed = true;
        }
      }
      if (changed) notify();
    },
    isSwitching: (workspaceRoot) =>
      switching.has(createWorkspaceRootKey(workspaceRoot)),
    setSwitching: (workspaceRoot, active) => {
      const workspaceKey = createWorkspaceRootKey(workspaceRoot);
      if (active === switching.has(workspaceKey)) return;
      if (active) switching.add(workspaceKey);
      else switching.delete(workspaceKey);
      notify();
    },
  };
};

const BRANCH_STATUS_STALE_MS = 20_000;

export const workspaceGitBranchStatusStore =
  createWorkspaceGitBranchStatusStore({
    load: (workspaceRoot, branchName, fetch) =>
      loadWorkspaceGitBranchStatus(workspaceRoot, branchName, { fetch }),
    now: () => Date.now(),
    schedule: (task) => {
      window.setTimeout(task, 0);
    },
    maxConcurrent: 2,
    staleMs: BRANCH_STATUS_STALE_MS,
  });

export const useWorkspaceGitBranchStatus = (
  workspaceRoot: string | null,
  branchName: string | null,
  enabled: boolean,
): WorkspaceGitBranchStatusEntry | undefined => {
  const root = enabled ? workspaceRoot : null;
  const entry = useSyncExternalStore(
    workspaceGitBranchStatusStore.subscribe,
    () =>
      root ? workspaceGitBranchStatusStore.get(root, branchName) : undefined,
  );
  useEffect(() => {
    if (!root) return;
    const unwatch = workspaceGitBranchStatusStore.watch(root, branchName);
    const refresh = (): void => {
      if (document.visibilityState === "visible") {
        workspaceGitBranchStatusStore.request(root, branchName);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unwatch();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [branchName, root]);
  return entry;
};

export const useWorkspaceGitBranchSwitching = (
  workspaceRoot: string | null,
): boolean =>
  useSyncExternalStore(workspaceGitBranchStatusStore.subscribe, () =>
    workspaceRoot
      ? workspaceGitBranchStatusStore.isSwitching(workspaceRoot)
      : false,
  );
