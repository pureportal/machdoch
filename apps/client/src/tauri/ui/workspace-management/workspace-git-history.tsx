import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { GitCommitHorizontal, RotateCcw } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import {
  WorkspaceGitResetDialog,
  type WorkspaceGitResetTarget,
} from "./workspace-git-reset-dialog";
import { formatWorkspaceGitTime } from "./workspace-git-time";

export const WorkspaceGitHistory = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const [resetTarget, setResetTarget] =
    useState<WorkspaceGitResetTarget | null>(null);
  const branch = overview.detached ? null : overview.branch;
  if (overview.recentCommits.length === 0) {
    return (
      <EmptyState
        icon={GitCommitHorizontal}
        title="No commits"
        size="compact"
      />
    );
  }
  return (
    <>
      <ol className="relative space-y-px border-l border-slate-800 pl-3">
        {overview.recentCommits.map((commit, index) => (
          <li key={commit.hash} className="group relative">
            <span
              aria-hidden="true"
              className="absolute top-3 -left-[17px] size-2 rounded-full border border-slate-600 bg-slate-950"
            />
            <CopyContextMenu
              values={[
                { label: "Copy commit hash", value: commit.hash },
                { label: "Copy subject", value: commit.subject },
              ]}
            >
              <div className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-900/70">
                <code className="shrink-0 text-[11px] text-sky-300/80">
                  {commit.shortHash}
                </code>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                  {commit.subject}
                </span>
                <span className="hidden shrink-0 truncate text-[11px] text-slate-500 sm:inline">
                  {commit.author}
                </span>
                <time
                  dateTime={commit.authoredAt}
                  title={new Date(commit.authoredAt).toLocaleString()}
                  className="shrink-0 text-[11px] text-slate-500"
                >
                  {formatWorkspaceGitTime(commit.authoredAt)}
                </time>
                {branch && index > 0 ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Reset ${branch} to ${commit.shortHash}`}
                    disabled={controls.busy}
                    onClick={() =>
                      setResetTarget({
                        revision: commit.hash,
                        label: commit.shortHash,
                      })
                    }
                    className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    <RotateCcw />
                  </Button>
                ) : null}
              </div>
            </CopyContextMenu>
          </li>
        ))}
      </ol>
      {resetTarget && branch ? (
        <WorkspaceGitResetDialog
          controls={controls}
          branch={branch}
          target={resetTarget}
          onClose={() => setResetTarget(null)}
        />
      ) : null}
    </>
  );
};
