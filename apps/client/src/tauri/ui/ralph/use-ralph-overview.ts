import { useEffect, useRef, useState } from "react";
import type { RalphFlowScope } from "../../../core/ralph.js";
import { startActivityPolling } from "../app-shell/activity-polling";
import {
  loadActiveDesktopTasks,
  loadRalphSnapshot,
  subscribeToDesktopTaskProgress,
  type ActiveDesktopTaskSummary,
} from "../runtime";
import {
  getRalphTaskFlowScope,
  normalizeWorkspaceForTaskComparison,
} from "./_helpers/parse-ralph-run-task-id.helper";
import {
  getRalphLibraryKey,
  isRalphActivityTask,
  type RalphOverviewLibrary,
} from "./ralph-overview-model";

const SNAPSHOT_INTERVAL_MS = 15_000;
const TASK_INTERVAL_MS = 2_000;
const MAX_SNAPSHOT_REQUESTS = 3;

export const useRalphOverview = (
  workspaceRoots: readonly string[],
  enabled: boolean,
) => {
  const [libraries, setLibraries] = useState<RalphOverviewLibrary[]>([]);
  const [tasks, setTasks] = useState<ActiveDesktopTaskSummary[]>([]);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const entriesRef = useRef(new Map<string, RalphOverviewLibrary>());
  const tasksRef = useRef<ActiveDesktopTaskSummary[]>([]);
  const discoveredRef = useRef(new Map<string, string>());
  const inFlightRef = useRef(new Set<string>());
  const activeSnapshotRequestsRef = useRef(0);
  const taskRequestRef = useRef<Promise<
    ActiveDesktopTaskSummary[] | null
  > | null>(null);
  const pumpRef = useRef<() => void>(() => {});
  const refreshRef = useRef<() => void>(() => {});
  const workspaceKey = JSON.stringify([
    ...new Map(
      workspaceRoots
        .filter((root) => root.trim())
        .map((root) => [normalizeWorkspaceForTaskComparison(root), root]),
    ).values(),
  ]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const roots = JSON.parse(workspaceKey) as string[];
    const queued = new Set<string>();
    const revisions = new Map<string, number>();
    const publish = () => setLibraries([...entriesRef.current.values()]);
    const visible = () => document.visibilityState !== "hidden";

    const pump = (): void => {
      if (disposed || !visible()) return;
      for (const key of queued) {
        if (activeSnapshotRequestsRef.current >= MAX_SNAPSHOT_REQUESTS) break;
        if (inFlightRef.current.has(key)) continue;
        queued.delete(key);
        const entry = entriesRef.current.get(key);
        if (!entry) continue;
        const requested = [entry];
        for (const peerKey of queued) {
          const peer = entriesRef.current.get(peerKey);
          if (
            peer &&
            peer.workspaceRoot === entry.workspaceRoot &&
            !inFlightRef.current.has(peerKey)
          ) {
            queued.delete(peerKey);
            requested.push(peer);
          }
        }
        const requestedRevisions = new Map(
          requested.map((library) => [library.key, revisions.get(library.key)]),
        );
        for (const library of requested) {
          inFlightRef.current.add(library.key);
          entriesRef.current.set(library.key, { ...library, loading: true });
        }
        activeSnapshotRequestsRef.current += 1;
        publish();
        void loadRalphSnapshot(
          entry.workspaceRoot,
          requested.length === 1 ? entry.scope : undefined,
        )
          .then((snapshot) => {
            if (disposed) return;
            for (const library of requested) {
              if (
                requestedRevisions.get(library.key) !==
                revisions.get(library.key)
              )
                continue;
              const scope = snapshot.scopes.find(
                (value) => value.scope === library.scope,
              );
              entriesRef.current.set(
                library.key,
                scope
                  ? {
                      ...library,
                      flows: scope.flows,
                      runs: scope.runs,
                      loaded: true,
                      loading: false,
                      error: null,
                    }
                  : {
                      ...library,
                      loading: false,
                      error:
                        "Flow status was not returned. Retry loading flows.",
                    },
              );
            }
            publish();
          })
          .catch((error: unknown) => {
            if (disposed) return;
            for (const library of requested) {
              if (
                requestedRevisions.get(library.key) !==
                revisions.get(library.key)
              )
                continue;
              entriesRef.current.set(library.key, {
                ...library,
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            publish();
          })
          .finally(() => {
            for (const library of requested)
              inFlightRef.current.delete(library.key);
            activeSnapshotRequestsRef.current -= 1;
            pumpRef.current();
          });
      }
    };
    pumpRef.current = pump;

    const enqueue = (key: string, invalidate = false): void => {
      if (!entriesRef.current.has(key)) return;
      if (!invalidate && inFlightRef.current.has(key)) return;
      if (invalidate) revisions.set(key, (revisions.get(key) ?? 0) + 1);
      queued.add(key);
    };

    const synchronizeLibraries = (): void => {
      for (const task of tasksRef.current) {
        discoveredRef.current.set(
          normalizeWorkspaceForTaskComparison(task.workspaceRoot),
          task.workspaceRoot,
        );
      }
      const desiredRoots = [
        ...new Map(
          [...roots, ...discoveredRef.current.values()].map((root) => [
            normalizeWorkspaceForTaskComparison(root),
            root,
          ]),
        ).values(),
      ];
      const desired: Array<{ workspaceRoot: string; scope: RalphFlowScope }> =
        desiredRoots.map((workspaceRoot) => ({
          workspaceRoot,
          scope: "workspace",
        }));
      if (desiredRoots[0])
        desired.unshift({ workspaceRoot: desiredRoots[0], scope: "user" });
      const keys = new Set<string>();
      for (const { workspaceRoot, scope } of desired) {
        const key = getRalphLibraryKey(workspaceRoot, scope);
        keys.add(key);
        const existing = entriesRef.current.get(key);
        if (existing) {
          if (existing.workspaceRoot !== workspaceRoot) {
            entriesRef.current.set(key, { ...existing, workspaceRoot });
            enqueue(key, true);
          }
          continue;
        }
        entriesRef.current.set(key, {
          key,
          workspaceRoot,
          scope,
          flows: [],
          runs: [],
          loaded: false,
          loading: true,
          error: null,
        });
        enqueue(key, true);
      }
      for (const key of entriesRef.current.keys()) {
        if (!keys.has(key)) {
          entriesRef.current.delete(key);
          queued.delete(key);
          revisions.set(key, (revisions.get(key) ?? 0) + 1);
        }
      }
      publish();
    };

    synchronizeLibraries();
    for (const key of entriesRef.current.keys()) enqueue(key, true);

    const taskPolling = startActivityPolling(
      async (signal) => {
        const request = taskRequestRef.current ?? loadActiveDesktopTasks();
        taskRequestRef.current = request;
        try {
          const result = await request;
          if (disposed || signal.aborted) return false;
          if (!result)
            throw new Error(
              "Activity could not be refreshed. Retry loading flows.",
            );
          const next = result.filter(isRalphActivityTask);
          const previous = tasksRef.current;
          if (JSON.stringify(next) !== JSON.stringify(previous)) {
            tasksRef.current = next;
            setTasks(next);
            synchronizeLibraries();
            const previousIds = new Set(previous.map((task) => task.id));
            const nextIds = new Set(next.map((task) => task.id));
            for (const task of [
              ...next.filter((task) => !previousIds.has(task.id)),
              ...previous.filter((task) => !nextIds.has(task.id)),
            ]) {
              enqueue(
                getRalphLibraryKey(
                  task.workspaceRoot,
                  getRalphTaskFlowScope(task),
                ),
                true,
              );
            }
            pump();
          }
          setTaskError(null);
          setTasksLoaded(true);
          return next.length > 0;
        } catch (error) {
          if (!disposed && !signal.aborted)
            setTaskError(
              error instanceof Error ? error.message : String(error),
            );
          throw error;
        } finally {
          if (taskRequestRef.current === request) taskRequestRef.current = null;
        }
      },
      () => TASK_INTERVAL_MS,
    );

    const refresh = (): void => {
      if (disposed || !visible()) return;
      taskPolling.refresh();
      for (const key of entriesRef.current.keys()) enqueue(key);
      pump();
    };
    refreshRef.current = () => {
      if (disposed || !visible()) return;
      taskPolling.refresh();
      for (const key of entriesRef.current.keys()) enqueue(key, true);
      pump();
    };
    pump();
    const timer = setInterval(refresh, SNAPSHOT_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    void subscribeToDesktopTaskProgress((event) => {
      const eventType = event.progress.timelineEvent?.metadata?.ralphEventType;
      if (
        disposed ||
        !visible() ||
        ![
          "start",
          "end",
          "crash",
          "input-requested",
          "input-submitted",
          "input-cancelled",
        ].includes(String(eventType))
      )
        return;
      const task = tasksRef.current.find((entry) => entry.id === event.taskId);
      if (task)
        enqueue(
          getRalphLibraryKey(task.workspaceRoot, getRalphTaskFlowScope(task)),
          true,
        );
      if (progressTimer !== undefined) return;
      progressTimer = setTimeout(() => {
        progressTimer = undefined;
        taskPolling.refresh();
        pump();
      }, 200);
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unsubscribe = cleanup;
      })
      .catch((error: unknown) => {
        if (!disposed)
          setTaskError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      queued.clear();
      clearInterval(timer);
      clearTimeout(progressTimer);
      taskPolling.stop();
      unsubscribe?.();
      document.removeEventListener("visibilitychange", refresh);
      refreshRef.current = () => {};
      pumpRef.current = () => {};
    };
  }, [enabled, workspaceKey]);

  return {
    libraries,
    tasks,
    taskError,
    tasksLoaded,
    refresh: () => refreshRef.current(),
  };
};
