import { useEffect, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import { toAppActivityState } from "../app-shell/operation-activity";
import { listSchedulerRuns, type SchedulerRunStatus } from "../runtime";
import {
  getCompletedSchedulerRunIds,
  isSchedulerRunActive,
} from "./scheduler-activity";

const ACTIVE_POLL_INTERVAL_MS = 5_000;
const IDLE_POLL_INTERVAL_MS = 60_000;
export const useSchedulerActivity = (
  workspaceRoots: readonly string[],
  viewed: boolean,
): AppActivityState => {
  const [running, setRunning] = useState(false);
  const [completedSinceView, setCompletedSinceView] = useState(false);
  const previousStatusesRef = useRef<Map<string, SchedulerRunStatus>>(
    new Map(),
  );
  const firstPollRef = useRef(true);
  const observedWorkspaceRootsRef = useRef(new Set<string>());
  const viewedRef = useRef(viewed);
  viewedRef.current = viewed;
  const workspaceSignature = [...new Set(workspaceRoots)].sort().join("\0");

  useEffect(() => {
    if (viewed) {
      setCompletedSinceView(false);
    }
  }, [viewed]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let hasActiveRuns = false;

    const poll = async (): Promise<void> => {
      if (cancelled) {
        return;
      }

      try {
        const roots = workspaceSignature.split("\0").filter(Boolean);
        const rootsSet = new Set(roots);
        for (const root of observedWorkspaceRootsRef.current) {
          if (!rootsSet.has(root))
            observedWorkspaceRootsRef.current.delete(root);
        }
        const nextStatuses = new Map<string, SchedulerRunStatus>();
        const successfulRoots = new Set<string>();
        let completedBetweenPolls = false;
        // Each read starts a CLI process. Bound fan-out across large workspace
        // lists and stop launching work when this effect has been disposed.
        for (let index = 0; index < roots.length && !cancelled; index += 2) {
          const results = await Promise.allSettled(
            roots.slice(index, index + 2).map(async (workspaceRoot) => ({
              workspaceRoot,
              result: await listSchedulerRuns(workspaceRoot),
            })),
          );
          for (const [offset, result] of results.entries()) {
            if (result.status === "fulfilled") {
              successfulRoots.add(result.value.workspaceRoot);
              for (const run of result.value.result.runs) {
                const key = `${result.value.workspaceRoot}\0${run.id}`;
                if (
                  observedWorkspaceRootsRef.current.has(
                    result.value.workspaceRoot,
                  ) &&
                  !previousStatusesRef.current.has(key) &&
                  !isSchedulerRunActive(run.status)
                )
                  completedBetweenPolls = true;
                nextStatuses.set(key, run.status);
              }
            } else {
              // A failed read is not evidence that an active run completed.
              const prefix = `${roots[index + offset]}\0`;
              for (const [key, status] of previousStatusesRef.current) {
                if (key.startsWith(prefix)) nextStatuses.set(key, status);
              }
            }
          }
        }

        if (cancelled) {
          return;
        }

        const completed = getCompletedSchedulerRunIds(
          previousStatusesRef.current,
          nextStatuses,
        );

        if (
          !firstPollRef.current &&
          (completed.length > 0 || completedBetweenPolls) &&
          !viewedRef.current
        ) {
          setCompletedSinceView(true);
        }

        firstPollRef.current = false;
        for (const root of successfulRoots)
          observedWorkspaceRootsRef.current.add(root);
        previousStatusesRef.current = nextStatuses;
        hasActiveRuns = [...nextStatuses.values()].some(isSchedulerRunActive);
        setRunning(hasActiveRuns);
      } catch {
        return;
      } finally {
        if (!cancelled && workspaceSignature) {
          timer = window.setTimeout(
            () => void poll(),
            hasActiveRuns ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
          );
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workspaceSignature]);

  return toAppActivityState(running, completedSinceView);
};
