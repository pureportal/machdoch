import { useCallback, useEffect, useState, type JSX } from "react";
import type { ConversationMemoryEntry } from "../../../core/types.js";
import type { WorkspaceManagementControls } from "./types";
import { WorkspaceMemoryPanel } from "./workspace-memory-panel";
import { WorkspaceReasoningBankPanel } from "./workspace-reasoning-bank-panel";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const WorkspaceMemorySection = ({
  workspaceRoot,
  workspaceSetup,
}: {
  workspaceRoot: string;
  workspaceSetup: WorkspaceManagementControls;
}): JSX.Element => {
  const { onLoadMemory, onForgetMemory, memorySourceSessions } = workspaceSetup;
  const [entries, setEntries] = useState<ConversationMemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void onLoadMemory(workspaceRoot)
      .then((loaded) => {
        if (!cancelled) setEntries(loaded);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onLoadMemory, workspaceRoot]);

  const forget = useCallback(
    async (id: string): Promise<void> => {
      setForgetting(true);
      setError(null);
      try {
        setEntries(await onForgetMemory(workspaceRoot, id));
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setForgetting(false);
      }
    },
    [onForgetMemory, workspaceRoot],
  );

  return (
    <div className="space-y-4">
      <WorkspaceMemoryPanel
        entries={entries}
        sourceSessions={memorySourceSessions}
        loading={loading}
        disabled={loading || forgetting}
        error={error}
        onForget={forget}
      />
      <WorkspaceReasoningBankPanel workspaceRoot={workspaceRoot} />
    </div>
  );
};
