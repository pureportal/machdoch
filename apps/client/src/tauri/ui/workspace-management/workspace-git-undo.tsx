import { LoaderCircle, Undo2 } from "lucide-react";
import { useState, type JSX } from "react";
import type { WorkspaceGitUndoPreview } from "@machdoch/fleet-protocol/workspace-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { loadWorkspaceGitUndo } from "./workspace-tools-runtime";

export const WorkspaceGitUndoButton = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const [preview, setPreview] = useState<
    WorkspaceGitUndoPreview | null | undefined
  >(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undoing = controls.pendingAction === "undo";

  const open = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setPreview(
        await loadWorkspaceGitUndo(
          overview.workspaceRoot,
          overview.repositoryRoot,
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  const close = (): void => {
    setPreview(undefined);
    setError(null);
  };

  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Undo last Git operation"
        tooltip="Undo"
        disabled={controls.busy || loading || overview.operation !== undefined}
        onClick={() => void open()}
      >
        {loading ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Undo2 className="size-3.5" />
        )}
      </Button>
      {preview !== undefined ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !undoing) close();
          }}
        >
          <DialogContent showCloseButton={false} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Undo</DialogTitle>
              <DialogDescription>
                {error ?? preview?.description ?? "Nothing to undo."}
              </DialogDescription>
            </DialogHeader>
            {preview ? (
              <div className="space-y-2 text-xs">
                <p className="text-slate-400">
                  <code className="text-sky-300">
                    {preview.currentHead.slice(0, 10)}
                  </code>
                  {" → "}
                  <code className="text-sky-300">
                    {preview.target.slice(0, 10)}
                  </code>
                  {preview.targetBranch ? ` (${preview.targetBranch})` : null}
                </p>
                {preview.files.length > 0 ? (
                  <ul className="max-h-48 space-y-px overflow-y-auto font-mono text-[11px] text-slate-300">
                    {preview.files.map((file) => (
                      <li key={file.path} className="flex gap-2">
                        <span className="w-3 text-slate-500">
                          {file.status}
                        </span>
                        <span className="truncate">{file.path}</span>
                      </li>
                    ))}
                    {preview.filesTruncated ? (
                      <li className="text-slate-500">…</li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={undoing}
                onClick={close}
              >
                Cancel
              </Button>
              {preview ? (
                <Button
                  type="button"
                  disabled={undoing}
                  onClick={() =>
                    void controls
                      .runAction("undo", { target: preview.target })
                      .then((done) => {
                        if (done) close();
                      })
                  }
                >
                  {undoing ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Undo2 />
                  )}
                  Undo
                </Button>
              ) : null}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
};
