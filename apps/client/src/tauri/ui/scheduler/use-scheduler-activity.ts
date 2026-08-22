import { useEffect, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import { toAppActivityState } from "../app-shell/operation-activity";
import { listSchedulerRuns, type SchedulerRunStatus } from "../runtime";
import {
  getCompletedSchedulerRunIds,
  isSchedulerRunActive,
} from "./scheduler-activity";

const POLL_INTERVAL_MS = 5_000;
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
  const workspaceSignature = [...workspaceRoots].sort().join("\0");

  useEffect(() => {
    if (viewed) {
      setCompletedSinceView(false);
    }
  }, [viewed]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const poll = async (): Promise<void> => {
      if (cancelled || inFlight) {
        return;
      }

      inFlight = true;

      try {
        const roots = workspaceSignature.split("\0").filter(Boolean);
        const results = await Promise.all(
          roots.map(async (workspaceRoot) => ({
            workspaceRoot,
            result: await listSchedulerRuns(workspaceRoot),
          })),
        );

        if (cancelled) {
          return;
        }

        const nextStatuses = new Map<string, SchedulerRunStatus>();
        for (const { workspaceRoot, result } of results) {
          for (const run of result.runs) {
            nextStatuses.set(`${workspaceRoot}\0${run.id}`, run.status);
          }
        }

        const completed = getCompletedSchedulerRunIds(
          previousStatusesRef.current,
          nextStatuses,
        );

        if (!firstPollRef.current && completed.length > 0 && !viewed) {
          setCompletedSinceView(true);
        }

        firstPollRef.current = false;
        previousStatusesRef.current = nextStatuses;
        setRunning([...nextStatuses.values()].some(isSchedulerRunActive));
      } catch {
        return;
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [viewed, workspaceSignature]);

  return toAppActivityState(running, completedSinceView);
};
