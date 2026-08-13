import { Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { WorkspaceRunSnapshot } from "../../../../shared/workspace-run.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { cn } from "../../lib/utils";
import {
  listenWorkspaceRunState,
  loadWorkspaceRunSnapshot,
} from "../../runtime";
import type { WorkspaceRunAiContext } from "../../workspace-management/workspace-run-ai";
import { WorkspaceRunPanel } from "../../workspace-management/workspace-run-panel";
import { workspaceRunIsActive } from "../../workspace-management/workspace-run-model";
import { createWorkspaceRootKey } from "../../workspace-management/workspace-management-model";

const RUN_RECONCILIATION_INTERVAL_MS = 5_000;

export const WorkspaceRunDialogControl = ({
  workspaceRoot,
  detectionContext,
}: {
  workspaceRoot: string | null | undefined;
  detectionContext?: WorkspaceRunAiContext;
}): JSX.Element => {
  const normalizedRoot = workspaceRoot?.trim() || null;
  const rootKey = normalizedRoot
    ? createWorkspaceRootKey(normalizedRoot)
    : null;
  const activeRootKeyRef = useRef(rootKey);
  activeRootKeyRef.current = rootKey;
  const [open, setOpen] = useState(false);
  const [documentDirty, setDocumentDirty] = useState(false);
  const [snapshot, setSnapshot] = useState<WorkspaceRunSnapshot | null>(null);

  const refreshSnapshot = useCallback(async (): Promise<void> => {
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
    setOpen(false);
    setDocumentDirty(false);
    setSnapshot(null);
    if (!normalizedRoot || !rootKey) return;

    let active = true;
    void refreshSnapshot();
    const interval = window.setInterval(() => {
      if (active) void refreshSnapshot();
    }, RUN_RECONCILIATION_INTERVAL_MS);
    let unlisten: (() => void) | undefined;
    void listenWorkspaceRunState((next) => {
      if (active && createWorkspaceRootKey(next.workspaceRoot) === rootKey) {
        setSnapshot(next);
      }
    })
      .then((listener) => {
        if (active) unlisten = listener;
        else listener();
      })
      .catch((cause) => {
        console.error("Failed to subscribe to workspace run state", cause);
      });

    return () => {
      active = false;
      window.clearInterval(interval);
      unlisten?.();
    };
  }, [normalizedRoot, refreshSnapshot, rootKey]);

  const running = snapshot?.configurations.some(workspaceRunIsActive) ?? false;
  const handleOpenChange = (nextOpen: boolean): void => {
    if (
      !nextOpen &&
      documentDirty &&
      !window.confirm("Discard unsaved run configuration changes?")
    ) {
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) setDocumentDirty(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!normalizedRoot}
          aria-label={running ? "Play, workspace running" : "Play workspace"}
          data-running={running ? "true" : "false"}
          className={cn(
            "relative h-9 rounded-2xl px-3 text-slate-300 hover:bg-slate-900 hover:text-white",
            running &&
              "border border-emerald-400/25 bg-emerald-500/10 text-emerald-100",
          )}
        >
          <span className="relative grid size-4 place-items-center">
            {running ? (
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/35 motion-reduce:animate-none" />
            ) : null}
            <Play
              aria-hidden="true"
              className={cn(
                "relative size-4",
                running && "fill-emerald-300 text-emerald-300",
              )}
            />
          </span>
          Play
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="grid max-h-[min(52rem,calc(100dvh-2rem))] w-[min(64rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl shadow-black/50 sm:max-w-none"
      >
        <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <DialogTitle>Run</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto p-5">
          <WorkspaceRunPanel
            workspaceRoot={normalizedRoot}
            detectionContext={detectionContext}
            onDocumentDirtyChange={setDocumentDirty}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
