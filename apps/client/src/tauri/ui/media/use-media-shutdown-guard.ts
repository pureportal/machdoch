import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useEffect } from "react";
import type { MediaRuntimeRunRecord } from "../../../core/media/contracts.js";

const ACTIVE_MEDIA_STATUSES = new Set(["queued", "running", "canceling"]);

export const getActiveMediaShutdownRuns = (
  runs: readonly MediaRuntimeRunRecord[],
): MediaRuntimeRunRecord[] =>
  runs.filter((run) => ACTIVE_MEDIA_STATUSES.has(run.status));

export const useMediaShutdownGuard = (): void => {
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !isTauri() ||
      !("__TAURI_INTERNALS__" in window)
    ) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        try {
          const runs = await invoke<MediaRuntimeRunRecord[]>("media_list_runs", {
            limit: 100,
          });
          const activeRuns = getActiveMediaShutdownRuns(runs);
          if (activeRuns.length === 0) return;
          const close = await confirm(
            `${activeRuns.length} Media Studio job${activeRuns.length === 1 ? " is" : "s are"} still active. Closing pauses local work; durable and remote jobs reconcile when Machdoch opens again. Close anyway?`,
            { title: "Media jobs are active", kind: "warning" },
          );
          if (!close) event.preventDefault();
        } catch (error) {
          console.error("Failed to inspect Media Studio jobs before closing", error);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error: unknown) => {
        console.error("Failed to register the Media Studio shutdown guard", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
};
