import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CloudDownload,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { SearchableSelect } from "@machdoch/media-studio/tauri/ui/components/ui/searchable-select.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceGitAction, WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { WorkspaceGitBranchPicker } from "./workspace-git-branch-picker";
import {
  workspaceGitActionProgressLabel,
  workspaceGitRepositoryLabel,
} from "./workspace-git-model";

const SUCCESS_VISIBLE_MS = 2_500;

const SyncButton = ({
  controls,
  action,
  label,
  icon: Icon,
  disabled,
  tooltip,
}: {
  controls: WorkspaceGitControls;
  action: WorkspaceGitAction;
  label: string;
  icon: typeof CloudDownload;
  disabled?: boolean;
  tooltip?: string;
}): JSX.Element => {
  const running =
    action === "fetch" ? controls.fetching : controls.pendingAction === action;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={controls.isActionBlocked(action) || disabled}
      tooltip={tooltip}
      onClick={() => void controls.runAction(action)}
      className="text-slate-300"
    >
      {running ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Icon className="size-3.5" />
      )}
      {label}
    </Button>
  );
};

const ActionStatus = ({
  controls,
}: {
  controls: WorkspaceGitControls;
}): JSX.Element | null => {
  const { feedback, pendingAction, fetching } = controls;
  const [visibleSuccessId, setVisibleSuccessId] = useState<number | null>(null);
  useEffect(() => {
    if (feedback?.tone !== "success") return;
    setVisibleSuccessId(feedback.id);
    const timeout = window.setTimeout(
      () => setVisibleSuccessId(null),
      SUCCESS_VISIBLE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  const progressAction = pendingAction ?? (fetching ? "fetch" : null);
  if (progressAction) {
    return (
      <span
        role="status"
        className="flex items-center gap-1.5 text-xs text-sky-200"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        {workspaceGitActionProgressLabel(progressAction)}
      </span>
    );
  }
  if (feedback?.tone === "success" && visibleSuccessId === feedback.id) {
    return (
      <span
        role="status"
        className="flex items-center gap-1.5 text-xs text-emerald-300"
      >
        <Check aria-hidden="true" className="size-3.5" />
        {feedback.text}
      </span>
    );
  }
  return null;
};

export const WorkspaceGitToolbar = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview | null;
}): JSX.Element => {
  const repositories = controls.repositories?.repositories ?? [];
  const publish = overview && !overview.upstream && !overview.detached;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
      {repositories.length > 1 ? (
        <SearchableSelect
          label="Git repository"
          value={controls.repositoryRoot ?? ""}
          options={repositories.map((repository) => ({
            value: repository.repositoryRoot,
            label: workspaceGitRepositoryLabel(repository),
          }))}
          disabled={controls.busy}
          onChange={controls.selectRepository}
          className="h-8 max-w-56 rounded-md border-slate-700 bg-slate-950 font-mono text-xs"
        />
      ) : null}
      {overview ? (
        <WorkspaceGitBranchPicker controls={controls} overview={overview} />
      ) : null}
      {overview?.upstream ? (
        <span className="hidden min-w-0 truncate text-[11px] text-slate-500 md:inline">
          {overview.upstream}
        </span>
      ) : null}
      {overview?.ahead ? (
        <span
          aria-label={`${overview.ahead} ahead`}
          className="text-xs text-emerald-300"
        >
          ↑{overview.ahead}
        </span>
      ) : null}
      {overview?.behind ? (
        <span
          aria-label={`${overview.behind} behind`}
          className="text-xs text-amber-300"
        >
          ↓{overview.behind}
        </span>
      ) : null}
      <span className="min-w-4 flex-1" />
      <ActionStatus controls={controls} />
      {overview ? (
        <div className="flex items-center">
          <SyncButton
            controls={controls}
            action="fetch"
            label="Fetch"
            icon={CloudDownload}
          />
          <SyncButton
            controls={controls}
            action="pull"
            label="Pull"
            icon={ArrowDownToLine}
            disabled={!overview.upstream}
            tooltip={overview.upstream ? undefined : "No upstream branch."}
          />
          <SyncButton
            controls={controls}
            action="push"
            label={publish ? "Publish" : "Push"}
            icon={ArrowUpFromLine}
            disabled={overview.detached || overview.remotes.length === 0}
            tooltip={
              overview.remotes.length === 0 ? "Add a remote first." : undefined
            }
          />
        </div>
      ) : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Refresh Git"
        disabled={controls.busy}
        onClick={() => void controls.refresh()}
      >
        <RefreshCw
          className={cn("size-3.5", controls.loading && "animate-spin")}
        />
      </Button>
    </div>
  );
};
