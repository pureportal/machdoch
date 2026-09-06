import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import { toAppActivityState } from "../app-shell/operation-activity";
import type { SchedulerRunStatus } from "../runtime";
import { loadSchedulerActivity } from "./scheduler-activity-runtime";
import {
  getCompletedSchedulerRunIds,
  isSchedulerRunActive,
  mergeSchedulerActivityStatuses,
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
  const inFlightRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);
  const workspaceSignature = [...new Set(workspaceRoots)].sort().join("\0");
  const recordCompletion = useEffectEvent((completed: boolean) => {
    if (completed && !viewed) {
      setCompletedSinceView(true);
    }
  });

  useEffect(() => {
    if (viewed) {
      setCompletedSinceView(false);
    }
  }, [viewed]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const roots = workspaceSignature.split("\0").filter(Boolean);
    const rootSet = new Set(roots);
    for (const root of observedWorkspaceRootsRef.current) {
      if (!rootSet.has(root)) observedWorkspaceRootsRef.current.delete(root);
    }
    previousStatusesRef.current = new Map(
      [...previousStatusesRef.current].filter(([key]) =>
        rootSet.has(key.split("\0")[0]),
      ),
    );

    if (roots.length === 0) {
      setRunning(false);
      setCompletedSinceView(false);
      firstPollRef.current = true;
      return;
    }

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      if (inFlightRef.current) {
        timer = window.setTimeout(() => void poll(), ACTIVE_POLL_INTERVAL_MS);
        return;
      }

      inFlightRef.current = true;

      try {
        const results = await loadSchedulerActivity(roots);

        if (cancelled) {
          return;
        }

        const nextStatuses = mergeSchedulerActivityStatuses(
          previousStatusesRef.current,
          results,
        );

        const completed = getCompletedSchedulerRunIds(
          previousStatusesRef.current,
          nextStatuses,
        );

        const completedBetweenPolls = [...nextStatuses].some(
          ([key, status]) =>
            observedWorkspaceRootsRef.current.has(key.split("\0")[0]) &&
            !previousStatusesRef.current.has(key) &&
            !isSchedulerRunActive(status),
        );
        recordCompletion(
          !firstPollRef.current &&
            (completed.length > 0 || completedBetweenPolls),
        );
        for (const result of results) {
          if ("runs" in result)
            observedWorkspaceRootsRef.current.add(result.workspaceRoot);
        }

        firstPollRef.current = false;
        previousStatusesRef.current = nextStatuses;
        setRunning([...nextStatuses.values()].some(isSchedulerRunActive));
        const errors = results.flatMap((result) =>
          "error" in result ? [`${result.workspaceRoot}: ${result.error}`] : [],
        );
        const error = errors.length > 0 ? errors.join("\n") : null;
        if (error && error !== lastErrorRef.current) {
          console.warn("Failed to refresh scheduler activity:", error);
        }
        lastErrorRef.current = error;
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (message !== lastErrorRef.current) {
            console.warn("Failed to refresh scheduler activity:", message);
          }
          lastErrorRef.current = message;
        }
      } finally {
        inFlightRef.current = false;
        if (!cancelled) {
          const hasActiveRuns = [...previousStatusesRef.current.values()].some(
            isSchedulerRunActive,
          );
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
