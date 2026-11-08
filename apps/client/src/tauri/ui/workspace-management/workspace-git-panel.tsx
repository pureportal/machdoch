import {
  Archive,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  History,
  LoaderCircle,
  Network,
  RefreshCw,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { JSX } from "react";
import { AppNotification } from "@machdoch/media-studio/tauri/ui/components/ui/notification.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceGitAction,
  WorkspaceGitOperation,
  WorkspaceGitOverview,
} from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { WorkspaceGitBranches } from "./workspace-git-branches";
import {
  WorkspaceGitChanges,
  type WorkspaceGitPathAction,
} from "./workspace-git-changes";
import { WorkspaceGitHistory } from "./workspace-git-history";
import { WorkspaceGitPullRequests } from "./workspace-git-pull-requests";
import { WorkspaceGitRemotes } from "./workspace-git-remotes";
import { WorkspaceGitRepositories } from "./workspace-git-repositories";
import { WorkspaceGitStashes } from "./workspace-git-stashes";
import { WorkspaceGitToolbar } from "./workspace-git-toolbar";
import { workspaceGitPathInWorkspace } from "./workspace-git-model";
import {
  WorkspaceTabList,
  workspaceTabId,
  workspaceTabPanelId,
  type WorkspaceTab,
} from "./workspace-tab-list";
import type { WorkspaceGitSection } from "./workspace-view-preferences";

const OPERATION_LABELS: Record<WorkspaceGitOperation, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
};

const OperationBanner = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element | null => {
  const operation = overview.operation;
  if (!operation) return null;
  const conflicts = overview.conflictedCount;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-y border-amber-900/50 bg-amber-950/25 px-3 py-2 text-xs text-amber-100"
    >
      <TriangleAlert aria-hidden="true" className="size-4 text-amber-300" />
      <span className="font-medium">{OPERATION_LABELS[operation]}</span>
      {conflicts ? (
        <span className="text-amber-200/80">
          {conflicts} {conflicts === 1 ? "conflict" : "conflicts"}
        </span>
      ) : null}
      <span className="flex-1" />
      <Button
        type="button"
        size="xs"
        disabled={controls.busy || conflicts > 0}
        tooltip={
          conflicts > 0 ? "Resolve and stage conflicts first." : undefined
        }
        onClick={() => void controls.runAction("continue-operation")}
      >
        Continue
      </Button>
      {operation !== "merge" ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={controls.busy}
          onClick={() => void controls.runAction("skip-operation")}
        >
          Skip
        </Button>
      ) : null}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={controls.busy}
        onClick={() => {
          if (
            window.confirm(
              `Abort the ${operation}? Its changes will be discarded.`,
            )
          ) {
            void controls.runAction("abort-operation");
          }
        }}
      >
        Abort
      </Button>
    </div>
  );
};

const OPERATION_STARTING_ACTIONS = new Set<WorkspaceGitAction>([
  "merge",
  "rebase",
  "pull",
  "restack",
]);

const ActionError = ({
  controls,
}: {
  controls: WorkspaceGitControls;
}): JSX.Element | null => {
  const { feedback, overview } = controls;
  if (feedback?.tone !== "error") return null;
  if (overview?.operation && OPERATION_STARTING_ACTIONS.has(feedback.action)) {
    return null;
  }
  const forceDelete =
    feedback.action === "delete-branch" &&
    feedback.text.includes("unmerged commits");
  return (
    <div className="px-3 pt-3">
      <AppNotification
        key={feedback.id}
        tone="error"
        dismissAfterMs={null}
        onDismiss={controls.dismissFeedback}
      >
        <span className="block whitespace-pre-wrap break-words">
          {feedback.text}
        </span>
        {forceDelete ? (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            className="mt-2"
            disabled={controls.busy}
            onClick={() =>
              void controls.runAction("delete-branch", {
                ...feedback.options,
                force: true,
              })
            }
          >
            Delete anyway
          </Button>
        ) : null}
      </AppNotification>
    </div>
  );
};

const gitTabs = (
  overview: WorkspaceGitOverview | null,
  pullRequestCount: number | undefined,
): WorkspaceTab<WorkspaceGitSection>[] => [
  {
    value: "changes",
    label: "Changes",
    icon: FileDiff,
    count: overview?.totalChanges,
  },
  { value: "branches", label: "Branches", icon: GitBranch },
  {
    value: "stashes",
    label: "Stashes",
    icon: Archive,
    count: overview?.stashes.length,
  },
  { value: "history", label: "History", icon: History },
  {
    value: "pull-requests",
    label: "Pull requests",
    icon: GitPullRequest,
    count: pullRequestCount,
  },
  { value: "remotes", label: "Remotes", icon: Network },
];

const SectionContent = ({
  section,
  controls,
  overview,
  onOpenPath,
}: {
  section: WorkspaceGitSection;
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  onOpenPath: (path: string, action: WorkspaceGitPathAction) => void;
}): JSX.Element => {
  switch (section) {
    case "changes":
      return (
        <WorkspaceGitChanges
          controls={controls}
          overview={overview}
          onOpenPath={onOpenPath}
        />
      );
    case "branches":
      return <WorkspaceGitBranches controls={controls} overview={overview} />;
    case "stashes":
      return <WorkspaceGitStashes controls={controls} overview={overview} />;
    case "history":
      return <WorkspaceGitHistory controls={controls} overview={overview} />;
    case "pull-requests":
      return (
        <WorkspaceGitPullRequests controls={controls} overview={overview} />
      );
    case "remotes":
      return <WorkspaceGitRemotes controls={controls} overview={overview} />;
  }
};

const PanelState = ({
  controls,
}: {
  controls: WorkspaceGitControls;
}): JSX.Element => {
  if (controls.repositories?.repositories.length === 0) {
    return (
      <EmptyState
        icon={controls.repositories.issues.length > 0 ? Unplug : FolderGit2}
        title="No Git repositories"
        description={controls.discoveryNotice ?? undefined}
        size="compact"
      />
    );
  }
  const error =
    controls.scope === "all"
      ? controls.repositoriesStatusError
      : (controls.error ?? controls.repositoriesError);
  const loading =
    controls.scope === "all"
      ? controls.repositoriesStatusLoading
      : controls.loading;
  if (error && !loading) {
    return (
      <EmptyState
        icon={Unplug}
        title="Repository unavailable"
        description={error}
        size="compact"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void controls.refresh()}
          >
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <div
      role="status"
      aria-label="Loading Git"
      className="grid h-40 place-items-center"
    >
      <LoaderCircle className="size-5 animate-spin text-slate-500" />
    </div>
  );
};

export const WorkspaceGitPanel = ({
  controls,
  section,
  onSectionChange,
  onOpenPath,
  className,
}: {
  controls: WorkspaceGitControls;
  section: WorkspaceGitSection;
  onSectionChange: (section: WorkspaceGitSection) => void;
  onOpenPath: (
    workspaceRelativePath: string,
    action: WorkspaceGitPathAction,
  ) => void;
  className?: string;
}): JSX.Element => {
  const { overview } = controls;
  const openRepositoryPath = (
    path: string,
    action: WorkspaceGitPathAction,
  ): void =>
    onOpenPath(
      workspaceGitPathInWorkspace(controls.selectedRepository, path),
      action,
    );
  return (
    <section
      aria-label="Git"
      aria-busy={controls.loading}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20",
        className,
      )}
    >
      <WorkspaceGitToolbar controls={controls} overview={overview} />
      {overview ? (
        <OperationBanner controls={controls} overview={overview} />
      ) : null}
      <ActionError controls={controls} />
      {controls.scope === "all" ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-800 p-3">
          {controls.repositoriesStatus ? (
            <WorkspaceGitRepositories
              controls={controls}
              onOpenPath={onOpenPath}
            />
          ) : (
            <PanelState controls={controls} />
          )}
        </div>
      ) : (
        <RepositoryContent
          controls={controls}
          section={section}
          onSectionChange={onSectionChange}
          onOpenPath={openRepositoryPath}
        />
      )}
    </section>
  );
};

const RepositoryContent = ({
  controls,
  section,
  onSectionChange,
  onOpenPath,
}: {
  controls: WorkspaceGitControls;
  section: WorkspaceGitSection;
  onSectionChange: (section: WorkspaceGitSection) => void;
  onOpenPath: (path: string, action: WorkspaceGitPathAction) => void;
}): JSX.Element => {
  const { overview } = controls;
  return (
    <>
      {overview && controls.error ? (
        <p role="alert" className="px-3 pt-2 text-xs text-red-300">
          {controls.error}
        </p>
      ) : null}
      <WorkspaceTabList
        scope="workspace-git"
        label="Git views"
        tabs={gitTabs(overview, controls.pullRequests?.items.length)}
        value={section}
        onChange={onSectionChange}
        className="border-b border-slate-800 px-2"
      />
      <div
        id={workspaceTabPanelId("workspace-git", section)}
        role="tabpanel"
        aria-labelledby={workspaceTabId("workspace-git", section)}
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        {overview ? (
          <SectionContent
            section={section}
            controls={controls}
            overview={overview}
            onOpenPath={onOpenPath}
          />
        ) : (
          <PanelState controls={controls} />
        )}
      </div>
    </>
  );
};
