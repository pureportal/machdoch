import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AppActivityState } from "../app-shell/app-rail";
import { toAppActivityState } from "../app-shell/operation-activity";
import type { MainAppId } from "../lib/shell-store";
import type { MediaRuntimeRunRecord } from "../../../core/media/contracts.js";
import { isMediaRunActive } from "./media-run-activity";
import { startActivityPolling } from "../app-shell/activity-polling";

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
  const activeAppRef = useRef(activeApp);
  activeAppRef.current = activeApp;
  const pollingRef = useRef<ReturnType<typeof startActivityPolling> | null>(
    null,
  );
  const previousAppRef = useRef(activeApp);

  useEffect(() => {
    if (activeApp === "media") {
      setCompletedSinceView(false);
      if (previousAppRef.current !== "media") pollingRef.current?.refresh();
    }
    previousAppRef.current = activeApp;
  }, [activeApp]);

  useEffect(() => {
    const poll = async (signal: AbortSignal): Promise<boolean> => {
      const runs = await loadRunsForActivity();
      if (signal.aborted) return false;

      const nextActiveRunIds = new Set(
        runs.filter(isMediaRunActive).map((run) => run.id),
      );
      const hasNewTerminalRun = [...previousActiveRunIdsRef.current].some(
        (runId) => !nextActiveRunIds.has(runId),
      );
      if (
        !firstPollRef.current &&
        hasNewTerminalRun &&
        activeAppRef.current !== "media"
      ) {
        setCompletedSinceView(true);
      }

      firstPollRef.current = false;
      previousActiveRunIdsRef.current = nextActiveRunIds;
      setRunning(nextActiveRunIds.size > 0);
      return nextActiveRunIds.size > 0;
    };

    const polling = startActivityPolling(poll, (active) =>
      active || activeAppRef.current === "media" ? POLL_INTERVAL_MS : 30_000,
    );
    pollingRef.current = polling;
    return () => {
      polling.stop();
      pollingRef.current = null;
    };
  }, []);

  return toAppActivityState(running, completedSinceView);
};
