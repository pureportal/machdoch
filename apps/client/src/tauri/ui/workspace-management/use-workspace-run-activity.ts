import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { listenWorkspaceRunState, loadWorkspaceRunSnapshot } from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";
import { workspaceRunIsActive } from "./workspace-run-model";

const RUN_RECONCILIATION_INTERVAL_MS = 5_000;

const collectRunStatuses = (
  statuses: readonly WorkspaceRunConfigurationStatus[],
): WorkspaceRunConfigurationStatus[] =>
  statuses.flatMap((status) => [
    status,
    ...collectRunStatuses(status.children),
  ]);

export interface WorkspaceRunActivity {
  snapshot: WorkspaceRunSnapshot | null;
  activeRuns: WorkspaceRunConfigurationStatus[];
  healthCheckFailed: boolean;
}

export const useWorkspaceRunActivity = (
  workspaceRoot: string | null | undefined,
): WorkspaceRunActivity => {
  const normalizedRoot = workspaceRoot?.trim() || null;
  const rootKey = normalizedRoot
    ? createWorkspaceRootKey(normalizedRoot)
    : null;
  const activeRootKeyRef = useRef(rootKey);
  activeRootKeyRef.current = rootKey;
  const [snapshot, setSnapshot] = useState<WorkspaceRunSnapshot | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!normalizedRoot || !rootKey) return;
    try {
      const next = await loadWorkspaceRunSnapshot(normalizedRoot);
      if (
        activeRootKeyRef.current === rootKey &&
        createWorkspaceRootKey(next.workspaceRoot) === rootKey
      ) {
        setSnapshot(next);
      }
    } catch (cause) {
      console.error("Failed to refresh workspace run state", cause);
    }
  }, [normalizedRoot, rootKey]);

  useEffect(() => {
    setSnapshot(null);
    if (!normalizedRoot || !rootKey) return;
    let active = true;
    void refresh();
    const interval = window.setInterval(() => {
      if (active) void refresh();
    }, RUN_RECONCILIATION_INTERVAL_MS);
    let unlisten: (() => void) | undefined;
    void listenWorkspaceRunState((next) => {
      if (active && createWorkspaceRootKey(next.workspaceRoot) === rootKey)
        setSnapshot(next);
    })
      .then((listener) => {
        if (active) unlisten = listener;
        else listener();
      })
      .catch((cause) =>
        console.error("Failed to subscribe to workspace run state", cause),
      );
    return () => {
      active = false;
      window.clearInterval(interval);
      unlisten?.();
    };
  }, [normalizedRoot, refresh, rootKey]);

  const activeRuns = snapshot
    ? collectRunStatuses(snapshot.configurations).filter(workspaceRunIsActive)
    : [];
  return {
    snapshot,
    activeRuns,
    healthCheckFailed: activeRuns.some(
      (status) => status.health?.state === "failed",
    ),
  };
};
