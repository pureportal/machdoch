import { useCallback, useEffect, useRef, useState } from "react";
import type { FleetShellRalphSnapshot } from "../runtime";
import { loadFleetRalphSnapshot } from "./fleet-ralph";

interface FleetRalphState {
  snapshot: FleetShellRalphSnapshot | null;
  loading: boolean;
  error: string | null;
}

const RALPH_REFRESH_MS = 5_000;

export const useFleetRalph = (
  workspaceRoot: string | null,
  enabled: boolean,
) => {
  const [ralphState, setRalphState] = useState<FleetRalphState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const workspaceRef = useRef(workspaceRoot);
  workspaceRef.current = workspaceRoot;
  const activeRef = useRef(false);
  const sequenceRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  const refreshRalph = useCallback((): Promise<void> => {
    if (!activeRef.current || !workspaceRef.current) {
      return Promise.resolve();
    }

    window.clearTimeout(timerRef.current);
    refreshQueuedRef.current = true;
    if (inFlightRef.current) return inFlightRef.current;

    const refresh = async (): Promise<void> => {
      while (activeRef.current && refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const sequence = sequenceRef.current;
        const isCurrent = (): boolean =>
          activeRef.current &&
          sequence === sequenceRef.current &&
          workspace === workspaceRef.current &&
          !refreshQueuedRef.current;

        setRalphState((current) => ({
          ...current,
          loading: true,
          error: null,
        }));

        try {
          const snapshot = await loadFleetRalphSnapshot(workspace);
          if (isCurrent()) {
            setRalphState({ snapshot, loading: false, error: null });
          }
        } catch (error) {
          if (!isCurrent()) continue;
          const message =
            error instanceof Error ? error.message : String(error);
          setRalphState((current) => ({
            snapshot: {
              ...(current.snapshot?.workspaceRoot === workspace
                ? current.snapshot
                : { workspaceRoot: workspace, flows: [], runs: [] }),
              loading: false,
              error: message,
              updatedAt: Date.now(),
            },
            loading: false,
            error: message,
          }));
        }
      }
    };

    const poll = (): void => {
      if (!activeRef.current || !workspaceRef.current) return;
      timerRef.current = window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          void refreshRalph();
        } else {
          poll();
        }
      }, RALPH_REFRESH_MS);
    };

    const request = refresh().finally(() => {
      inFlightRef.current = null;
      poll();
    });
    inFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    activeRef.current = enabled;
    if (enabled) {
      setRalphState((current) => {
        if (!workspaceRoot) {
          return {
            snapshot: {
              loading: false,
              flows: [],
              runs: [],
              updatedAt: Date.now(),
            },
            loading: false,
            error: null,
          };
        }
        return current.snapshot?.workspaceRoot === workspaceRoot
          ? current
          : { snapshot: null, loading: true, error: null };
      });
      void refreshRalph();
    }

    return () => {
      activeRef.current = false;
      refreshQueuedRef.current = false;
      sequenceRef.current += 1;
      window.clearTimeout(timerRef.current);
    };
  }, [enabled, workspaceRoot, refreshRalph]);

  return { ralphState, setRalphState, refreshRalph };
};
