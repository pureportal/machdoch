import { useEffect, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import type { MainAppId } from "../lib/shell-store";
import { loadActiveDesktopTasks } from "../runtime";

const POLL_INTERVAL_MS = 5_000;
const ACTIVE_TASK_GRACE_MS = 3_000;

const toActivityState = (
  running: boolean,
  completed: boolean,
): AppActivityState => {
  if (running && completed) {
    return "running-and-completed";
  }

  if (running) {
    return "running";
  }

  return completed ? "completed" : "idle";
};

export const useRalphActivity = (activeApp: MainAppId): AppActivityState => {
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [completedSinceView, setCompletedSinceView] = useState(false);
  const previousTaskIdsRef = useRef<Set<string>>(new Set());
  const firstPollRef = useRef(true);
  const lastRunningAtRef = useRef(0);

  useEffect(() => {
    if (activeApp === "ralph") {
      setCompletedSinceView(false);
    }
  }, [activeApp]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const poll = async (): Promise<void> => {
      if (cancelled || inFlight) {
        return;
      }

      inFlight = true;

      try {
        const activeTasks = await loadActiveDesktopTasks();

        if (cancelled || !activeTasks) {
          return;
        }

        const nextTaskIds = new Set(
          activeTasks
            .filter((task) => task.kind === "ralph")
            .map((task) => task.id),
        );
        const previousTaskIds = previousTaskIdsRef.current;
        const finishedTaskIds = [...previousTaskIds].filter(
          (taskId) => !nextTaskIds.has(taskId),
        );
        const now = Date.now();

        if (nextTaskIds.size > 0) {
          lastRunningAtRef.current = now;
        }

        if (
          !firstPollRef.current &&
          finishedTaskIds.length > 0 &&
          activeApp !== "ralph"
        ) {
          setCompletedSinceView(true);
        }

        firstPollRef.current = false;
        previousTaskIdsRef.current = nextTaskIds;
        setRunningTaskIds(nextTaskIds);
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeApp]);

  const running =
    runningTaskIds.size > 0 ||
    Date.now() - lastRunningAtRef.current <= ACTIVE_TASK_GRACE_MS;

  return toActivityState(running, completedSinceView);
};
