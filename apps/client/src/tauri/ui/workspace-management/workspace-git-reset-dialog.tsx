import { LoaderCircle, RotateCcw } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceGitResetMode } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";

export interface WorkspaceGitResetTarget {
  revision: string;
  label: string;
}

const MODES: {
  value: WorkspaceGitResetMode;
  label: string;
  description: string;
}[] = [
  {
    value: "keep",
    label: "Keep changes",
    description: "Removed commits stay as uncommitted changes.",
  },
  {
    value: "discard",
    label: "Discard changes",
    description: "Uncommitted changes are deleted and cannot be restored.",
  },
];

export const WorkspaceGitResetDialog = ({
  controls,
  branch,
  target,
  onClose,
}: {
  controls: WorkspaceGitControls;
  branch: string;
  target: WorkspaceGitResetTarget;
  onClose: () => void;
}): JSX.Element => {
  const [mode, setMode] = useState<WorkspaceGitResetMode>("keep");
  const resetting = controls.pendingAction === "reset";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !resetting) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Reset {branch} to {target.label}?
          </DialogTitle>
          <DialogDescription>
            Commits on {branch} that are not in {target.label} will no longer be
            on this branch.
          </DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label="Local changes"
          className="grid gap-2"
        >
          {MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              disabled={resetting}
              onClick={() => setMode(option.value)}
              className={cn(
                "grid gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                mode === option.value
                  ? option.value === "discard"
                    ? "border-red-500/40 bg-red-500/10"
                    : "border-sky-500/40 bg-sky-500/10"
                  : "border-slate-800 hover:bg-slate-900",
              )}
            >
              <span className="text-sm font-medium text-slate-100">
                {option.label}
              </span>
              <span className="text-xs text-slate-400">
                {option.description}
              </span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={resetting}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={mode === "discard" ? "destructive" : "default"}
            disabled={resetting}
            onClick={() =>
              void controls
                .runAction("reset", {
                  startPoint: target.revision,
                  resetMode: mode,
                })
                .then((reset) => {
                  if (reset) onClose();
                })
            }
          >
            {resetting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
