import { LoaderCircle, Trash2 } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
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
import {
  branchCleanupCandidates,
  type BranchCandidate,
  type CleanupCandidate,
} from "./workspace-git-branch-search";

const REASONS: Record<CleanupCandidate["reason"], string> = {
  merged: "merged",
  gone: "upstream deleted",
  stale: "no commits for 90 days",
};

export const WorkspaceGitBranchCleanup = ({
  controls,
  overview,
  candidates,
  onClose,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  candidates: readonly BranchCandidate[];
  onClose: () => void;
}): JSX.Element => {
  const cleanup = useMemo(
    () =>
      branchCleanupCandidates(
        candidates,
        new Set(
          [overview.defaultBranch, "main", "master", "develop"].filter(
            Boolean,
          ) as string[],
        ),
        Date.now(),
      ),
    [candidates, overview.defaultBranch],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        cleanup
          .filter((branch) => branch.reason !== "stale")
          .map((branch) => branch.name),
      ),
  );
  const deleting = controls.pendingAction === "delete-branches";
  const unmerged = cleanup.some(
    (branch) => selected.has(branch.name) && branch.reason !== "merged",
  );

  const toggle = (name: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const remove = async (): Promise<void> => {
    const branchNames = cleanup
      .map((branch) => branch.name)
      .filter((name) => selected.has(name));
    if (
      await controls.runAction("delete-branches", {
        branchNames,
        force: unmerged,
      })
    )
      onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clean up branches</DialogTitle>
          {cleanup.length === 0 ? (
            <DialogDescription>Nothing to clean up.</DialogDescription>
          ) : null}
        </DialogHeader>
        {cleanup.length > 0 ? (
          <ul className="max-h-72 space-y-px overflow-y-auto">
            {cleanup.map((branch) => (
              <li key={branch.name}>
                <label className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-(--app-hover)">
                  <input
                    type="checkbox"
                    checked={selected.has(branch.name)}
                    onChange={() => toggle(branch.name)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-slate-200">
                    {branch.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-500">
                    {REASONS[branch.reason]}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        {unmerged ? (
          <p className="text-xs text-amber-300">
            Unmerged commits on the selected branches are deleted with them.
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={deleting}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting || selected.size === 0}
            onClick={() => void remove()}
          >
            {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Delete {selected.size}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
