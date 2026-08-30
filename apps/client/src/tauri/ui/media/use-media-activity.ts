import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import { toAppActivityState } from "../app-shell/operation-activity";
import type { MainAppId } from "../lib/shell-store";
import type { MediaRuntimeRunRecord } from "../../../core/media/contracts.js";
import { isMediaRunActive } from "./media-run-activity";

const POLL_INTERVAL_MS = 2_000;

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

export const useMediaActivity = (activeApp: MainAppId): AppActivityState => {
  const [running, setRunning] = useState(false);
  const [completedSinceView, setCompletedSinceView] = useState(false);
  const previousActiveRunIdsRef = useRef<Set<string>>(new Set());
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

        const nextActiveRunIds = new Set(
          runs.filter(isMediaRunActive).map((run) => run.id),
        );
        const hasNewTerminalRun = [...previousActiveRunIdsRef.current].some(
          (runId) => !nextActiveRunIds.has(runId),
        );
        if (
          !firstPollRef.current &&
          hasNewTerminalRun &&
          activeApp !== "media"
        ) {
          setCompletedSinceView(true);
        }

        firstPollRef.current = false;
        previousActiveRunIdsRef.current = nextActiveRunIds;
        setRunning(nextActiveRunIds.size > 0);
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

  return toAppActivityState(running, completedSinceView);
};
