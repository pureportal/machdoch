import { CircleAlert, Play } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { useWorkspaceRunActivity } from "../../workspace-management/use-workspace-run-activity";
import { useWorkspaceRunDetectionState } from "../../workspace-management/workspace-run-detection-state";
import { WorkspaceRunPanel } from "../../workspace-management/workspace-run-panel";
import { createWorkspaceRootKey } from "../../workspace-management/workspace-management-model";

export const WorkspaceRunDialogControl = ({
  workspaceRoot,
  primaryTaskRunning,
}: {
  workspaceRoot: string | null | undefined;
  primaryTaskRunning: boolean;
}): JSX.Element => {
  const normalizedRoot = workspaceRoot?.trim() || null;
  const rootKey = normalizedRoot
    ? createWorkspaceRootKey(normalizedRoot)
    : null;
  const [open, setOpen] = useState(false);
  const [documentDirty, setDocumentDirty] = useState(false);
  const detectionState = useWorkspaceRunDetectionState(normalizedRoot);
  const { activeRuns: activeRunStatuses, healthCheckFailed } =
    useWorkspaceRunActivity(normalizedRoot);

  useEffect(() => {
    setOpen(false);
    setDocumentDirty(false);
  }, [rootKey]);

  const detecting = detectionState.phase === "detecting";
  const scriptRunning = activeRunStatuses.length > 0;
  const runAriaLabel = [
    "Run workspace",
    scriptRunning ? "process running" : null,
    healthCheckFailed ? "health check failed" : null,
  ]
    .filter(Boolean)
    .join(", ");
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
          aria-label={runAriaLabel}
          data-detecting={detecting ? "true" : "false"}
          data-script-running={scriptRunning ? "true" : "false"}
          data-health-check-failed={healthCheckFailed ? "true" : "false"}
          data-primary-task-running={primaryTaskRunning ? "true" : "false"}
          className={cn(
            "relative isolate h-7 shrink-0 overflow-hidden rounded-lg border border-transparent px-2 text-[11px] text-slate-300 hover:bg-slate-900 hover:text-white",
            scriptRunning &&
              "border-emerald-400/25 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15 hover:text-emerald-50",
            !scriptRunning &&
              primaryTaskRunning &&
              "border-sky-400/25 bg-sky-500/10 text-sky-100",
            !scriptRunning &&
              !primaryTaskRunning &&
              detecting &&
              "border-violet-400/25 bg-violet-500/10 text-violet-100",
          )}
        >
          {primaryTaskRunning ? (
            <span
              aria-hidden="true"
              data-run-activity="primary-task"
              className="absolute inset-0 animate-pulse bg-sky-400/[0.07] motion-reduce:animate-none"
            />
          ) : null}
          <span className="relative z-10 grid size-4 place-items-center">
            {scriptRunning ? (
              <span
                aria-hidden="true"
                data-run-activity="script"
                className={cn(
                  "absolute inset-0 animate-ping rounded-full motion-reduce:animate-none",
                  "bg-emerald-400/30",
                )}
              />
            ) : null}
            {detecting ? (
              <span
                aria-hidden="true"
                data-run-activity="detection"
                className="absolute -inset-0.5 animate-spin rounded-full border border-violet-300/60 border-b-transparent motion-reduce:animate-none"
              />
            ) : null}
            <Play
              aria-hidden="true"
              className={cn(
                "relative size-4",
                scriptRunning && "fill-emerald-300 text-emerald-300",
                !scriptRunning && primaryTaskRunning && "text-sky-300",
                !scriptRunning &&
                  !primaryTaskRunning &&
                  detecting &&
                  "text-violet-300",
              )}
            />
          </span>
          <span className="relative z-10">Run</span>
          {healthCheckFailed ? (
            <CircleAlert
              aria-hidden="true"
              data-run-health="failed"
              className="relative z-10 size-3.5 text-rose-300"
            />
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="grid h-[min(48rem,calc(100dvh-2rem))] w-[min(76rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl shadow-black/50 sm:max-w-none"
      >
        <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <DialogTitle>Run</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 p-4">
          {open ? (
            <WorkspaceRunPanel
              workspaceRoot={normalizedRoot}
              onDocumentDirtyChange={setDocumentDirty}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
