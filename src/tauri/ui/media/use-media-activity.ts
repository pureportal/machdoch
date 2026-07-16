import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import type { MainAppId } from "../lib/shell-store";
import type { MediaRuntimeRunRecord } from "../../../core/media/contracts.js";

const POLL_INTERVAL_MS = 2_000;
const ACTIVE_STATUSES = new Set(["queued", "running", "canceling"]);

const loadRunsForActivity = async (): Promise<MediaRuntimeRunRecord[]> => {
  if (
    typeof window !== "undefined" &&
    isTauri() &&
    "__TAURI_INTERNALS__" in window
  ) {
    return invoke<MediaRuntimeRunRecord[]>("media_list_runs", { limit: 100 });
  }

  const runtime = await import("./media-runtime");
  return runtime.listMediaRuns();
};

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

export const useMediaActivity = (activeApp: MainAppId): AppActivityState => {
  const [running, setRunning] = useState(false);
  const [completedSinceView, setCompletedSinceView] = useState(false);
  const previousStatusesRef = useRef<Map<string, string>>(new Map());
  const firstPollRef = useRef(true);

  useEffect(() => {
    if (activeApp === "media") {
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
        const runs = await loadRunsForActivity();
        if (cancelled) {
          return;
        }

        const nextStatuses = new Map(runs.map((run) => [run.id, run.status]));
        const hasNewTerminalRun = [...nextStatuses].some(([runId, status]) => {
          const previous = previousStatusesRef.current.get(runId);
          return (
            previous !== undefined &&
            ACTIVE_STATUSES.has(previous) &&
            !ACTIVE_STATUSES.has(status)
          );
        });
        if (
          !firstPollRef.current &&
          hasNewTerminalRun &&
          activeApp !== "media"
        ) {
          setCompletedSinceView(true);
        }

        firstPollRef.current = false;
        previousStatusesRef.current = nextStatuses;
        setRunning(runs.some((run) => ACTIVE_STATUSES.has(run.status)));
      } catch {
        // The Media Studio surface owns detailed runtime error reporting.
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeApp]);

  return toActivityState(running, completedSinceView);
};
