import { useEffect, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import {
  getCompletedOperationIds,
  toAppActivityState,
} from "../app-shell/operation-activity";
import type { MainAppId } from "../lib/shell-store";
import { loadActiveDesktopTasks } from "../runtime";
import { startActivityPolling } from "../app-shell/activity-polling";

const POLL_INTERVAL_MS = 5_000;
const ACTIVE_TASK_GRACE_MS = 3_000;

export const useRalphActivity = (activeApp: MainAppId): AppActivityState => {
  const [running, setRunning] = useState(false);
  const [completedSinceView, setCompletedSinceView] = useState(false);
  const previousTaskIdsRef = useRef<Set<string>>(new Set());
  const firstPollRef = useRef(true);
  const lastRunningAtRef = useRef(0);
  const activeAppRef = useRef(activeApp);
  activeAppRef.current = activeApp;
  const previousAppRef = useRef(activeApp);
  const pollingRef = useRef<ReturnType<typeof startActivityPolling> | null>(
    null,
  );

  useEffect(() => {
    if (activeApp === "ralph") {
      setCompletedSinceView(false);
      if (previousAppRef.current !== "ralph") pollingRef.current?.refresh();
    }
    previousAppRef.current = activeApp;
  }, [activeApp]);

  useEffect(() => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (signal: AbortSignal): Promise<boolean> => {
      const activeTasks = await loadActiveDesktopTasks();

      if (signal.aborted) return false;
      if (!activeTasks)
        throw new Error("Active tasks are temporarily unavailable.");

      const nextTaskIds = new Set(
        activeTasks
          .filter((task) => task.kind === "ralph")
          .map((task) => task.id),
      );
      const previousTaskIds = previousTaskIdsRef.current;
      const finishedTaskIds = getCompletedOperationIds(
        previousTaskIds,
        nextTaskIds,
      );
      const now = Date.now();

      if (nextTaskIds.size > 0) {
        lastRunningAtRef.current = now;
      }

      if (
        !firstPollRef.current &&
        finishedTaskIds.length > 0 &&
        activeAppRef.current !== "ralph"
      ) {
        setCompletedSinceView(true);
      }

      firstPollRef.current = false;
      previousTaskIdsRef.current = nextTaskIds;
      clearTimeout(graceTimer);
      const remainingGrace =
        lastRunningAtRef.current > 0
          ? ACTIVE_TASK_GRACE_MS - (now - lastRunningAtRef.current)
          : 0;
      const stillRunning = nextTaskIds.size > 0 || remainingGrace > 0;
      setRunning(stillRunning);
      if (nextTaskIds.size === 0 && remainingGrace > 0) {
        graceTimer = setTimeout(() => {
          if (!signal.aborted) setRunning(false);
        }, remainingGrace);
      }
      return stillRunning;
    };

    const polling = startActivityPolling(poll, (active) =>
      active || activeAppRef.current === "ralph" ? POLL_INTERVAL_MS : 30_000,
    );
    pollingRef.current = polling;

    return () => {
      polling.stop();
      clearTimeout(graceTimer);
      pollingRef.current = null;
    };
  }, []);

  return toAppActivityState(running, completedSinceView);
};
