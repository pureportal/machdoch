import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { GitCommitHorizontal } from "lucide-react";
import type { JSX } from "react";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import type { WorkspaceGitOverview } from "../runtime";
import { formatWorkspaceGitTime } from "./workspace-git-time";

export const WorkspaceGitHistory = ({
  overview,
}: {
  overview: WorkspaceGitOverview;
}): JSX.Element =>
  overview.recentCommits.length === 0 ? (
    <EmptyState icon={GitCommitHorizontal} title="No commits" size="compact" />
  ) : (
    <ol className="relative space-y-px border-l border-slate-800 pl-3">
      {overview.recentCommits.map((commit) => (
        <li key={commit.hash} className="relative">
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
            <div className="flex min-w-0 items-baseline gap-3 rounded-md px-2 py-1.5 hover:bg-slate-900/70">
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
            </div>
          </CopyContextMenu>
        </li>
      ))}
    </ol>
  );
