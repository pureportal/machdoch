import { isTauri } from "@tauri-apps/api/core";
import { GitPullRequest, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { manageCloudWorkspaces } from "../cloud/workspace-runtime";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { WorkspaceGitPullRequestForm } from "./workspace-git-pull-request-form";
import { WorkspaceGitPullRequestRow } from "./workspace-git-pull-request-row";
import { cloudOriginForWorkspace } from "./workspace-pull-request-links";

const useCloudOrigin = (workspaceRoot: string): string | null => {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    manageCloudWorkspaces({ action: "list", refresh: false })
      .then((connections) => {
        if (active)
          setOrigin(cloudOriginForWorkspace(connections, workspaceRoot));
      })
      .catch((error: unknown) =>
        console.error("Loading cloud connections failed", error),
      );
    return () => {
      active = false;
    };
  }, [workspaceRoot]);
  return origin;
};

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
  const [creating, setCreating] = useState(false);
  const cloudOrigin = useCloudOrigin(overview.workspaceRoot);
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
              controls.isActionBlocked("create-pull-request") ||
              overview.remotes.length === 0
            }
            onClick={() => setCreating(true)}
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
      {creating ? (
        <WorkspaceGitPullRequestForm
          controls={controls}
          overview={overview}
          template={pullRequests?.template}
          onDone={() => setCreating(false)}
        />
      ) : null}
      {pullRequests?.items.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No open pull requests"
          size="compact"
        />
      ) : (
        <ul className="space-y-1">
          {pullRequests?.items.map((pullRequest) => (
            <WorkspaceGitPullRequestRow
              key={pullRequest.number}
              overview={overview}
              pullRequest={pullRequest}
              cloudOrigin={cloudOrigin}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
