import {
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, type JSX } from "react";
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { openExternalUrl, type WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { formatWorkspaceGitTime } from "./workspace-git-time";

export const WorkspaceGitPullRequests = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const {
    ensurePullRequests,
    pullRequests,
    pullRequestsError,
    pullRequestsLoading,
  } = controls;
  useEffect(() => {
    ensurePullRequests();
  }, [ensurePullRequests, overview.repositoryRoot]);

  const currentHasPullRequest = pullRequests?.items.some(
    (item) => item.headBranch === overview.branch,
  );

  if (pullRequestsLoading && !pullRequests) {
    return (
      <div
        role="status"
        aria-label="Loading pull requests"
        className="grid h-36 place-items-center"
      >
        <LoaderCircle className="size-5 animate-spin text-slate-500" />
      </div>
    );
  }
  if (pullRequestsError || (pullRequests && !pullRequests.available)) {
    return (
      <EmptyState
        icon={GitPullRequest}
        title="Pull requests unavailable"
        description={pullRequestsError ?? pullRequests?.reason}
        size="compact"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={ensurePullRequests}
          >
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        {overview.branch && !overview.detached && !currentHasPullRequest ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              controls.isActionBlocked("submit-pull-requests") ||
              overview.remotes.length === 0
            }
            onClick={() => void controls.runAction("submit-pull-requests")}
          >
            <GitPullRequest className="size-4" />
            Create for {overview.branch}
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh pull requests"
          disabled={pullRequestsLoading}
          onClick={ensurePullRequests}
        >
          <RefreshCw
            className={
              pullRequestsLoading ? "size-3.5 animate-spin" : "size-3.5"
            }
          />
        </Button>
      </div>
      {pullRequests?.items.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No open pull requests"
          size="compact"
        />
      ) : (
        <ul className="space-y-1">
          {pullRequests?.items.map((pullRequest) => (
            <li key={pullRequest.number}>
              <button
                type="button"
                onClick={() => void openExternalUrl(pullRequest.url)}
                className="flex w-full min-w-0 items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-left hover:border-slate-700 hover:bg-slate-900/60"
              >
                <GitPullRequest
                  aria-hidden="true"
                  className={
                    pullRequest.draft
                      ? "mt-0.5 size-4 shrink-0 text-slate-500"
                      : "mt-0.5 size-4 shrink-0 text-emerald-300"
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">
                    <span className="text-slate-500">
                      #{pullRequest.number}
                    </span>{" "}
                    {pullRequest.title}
                  </p>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {pullRequest.headBranch} → {pullRequest.baseBranch}
                    {pullRequest.updatedAt
                      ? ` · ${formatWorkspaceGitTime(pullRequest.updatedAt)}`
                      : ""}
                  </p>
                </div>
                {pullRequest.draft ? (
                  <Badge variant="outline">Draft</Badge>
                ) : null}
                {pullRequest.headBranch === overview.branch ? (
                  <Badge variant="secondary">Current</Badge>
                ) : null}
                <ExternalLink
                  aria-hidden="true"
                  className="size-3.5 text-slate-600"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
