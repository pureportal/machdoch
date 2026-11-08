import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceGitChange,
  WorkspaceGitRepositoryStatus,
} from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { WorkspaceGitBranchTarget } from "./workspace-git-branch-target";
import type { WorkspaceGitPathAction } from "./workspace-git-changes";
import { WorkspaceGitDiffView } from "./workspace-git-diff";
import {
  workspaceGitChangeLabel,
  workspaceGitPathInWorkspace,
  workspaceGitRepositoryLabel,
} from "./workspace-git-model";
import { createWorkspaceRootKey } from "./workspace-management-model";

const COLLAPSED_CHANGE_ROWS = 12;

const OPERATION_LABELS: Record<
  NonNullable<WorkspaceGitRepositoryStatus["operation"]>,
  string
> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
};

interface SelectedChange {
  repositoryRoot: string;
  path: string;
}

const changeTone = (change: WorkspaceGitChange): string => {
  if (change.conflicted) return "text-red-300";
  if (change.untracked) return "text-emerald-300";
  if (change.status.includes("D")) return "text-rose-300";
  if (change.status.includes("R")) return "text-violet-300";
  return "text-amber-300";
};

const changeLetter = (change: WorkspaceGitChange): string => {
  if (change.conflicted) return "!";
  if (change.untracked) return "U";
  return change.status.trim()[0] ?? "M";
};

const ChangeSummary = ({
  repository,
}: {
  repository: WorkspaceGitRepositoryStatus;
}): JSX.Element => {
  if (repository.totalChanges === 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
        <Check aria-hidden="true" className="size-3 text-emerald-400" />
        Clean
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px]">
      {repository.conflictedCount > 0 ? (
        <span className="font-medium text-red-300">
          {repository.conflictedCount}{" "}
          {repository.conflictedCount === 1 ? "conflict" : "conflicts"}
        </span>
      ) : null}
      <span className="text-amber-200">
        {repository.totalChanges}{" "}
        {repository.totalChanges === 1 ? "change" : "changes"}
      </span>
    </span>
  );
};

const SyncState = ({
  repository,
}: {
  repository: WorkspaceGitRepositoryStatus;
}): JSX.Element | null => {
  if (repository.upstreamGone) {
    return (
      <span className="shrink-0 rounded-full border border-slate-700 px-1.5 text-[10px] text-slate-400">
        upstream gone
      </span>
    );
  }
  if (!repository.upstream && !repository.detached) {
    return (
      <span className="shrink-0 text-[10px] text-slate-500">Not published</span>
    );
  }
  return (
    <>
      {repository.ahead ? (
        <span
          aria-label={`${repository.ahead} ahead`}
          className="shrink-0 text-[11px] text-emerald-300"
        >
          ↑{repository.ahead}
        </span>
      ) : null}
      {repository.behind ? (
        <span
          aria-label={`${repository.behind} behind`}
          className="shrink-0 text-[11px] text-amber-300"
        >
          ↓{repository.behind}
        </span>
      ) : null}
    </>
  );
};

const RepositoryCard = ({
  repository,
  controls,
  selected,
  onSelectChange,
}: {
  repository: WorkspaceGitRepositoryStatus;
  controls: WorkspaceGitControls;
  selected: SelectedChange | null;
  onSelectChange: (change: SelectedChange) => void;
}): JSX.Element => {
  const [expanded, setExpanded] = useState(repository.totalChanges > 0);
  const [showAll, setShowAll] = useState(false);
  const label = workspaceGitRepositoryLabel(repository);
  const fetching = controls.fetchingRepositories.has(
    createWorkspaceRootKey(repository.repositoryRoot),
  );
  const visibleChanges = showAll
    ? repository.changes
    : repository.changes.slice(0, COLLAPSED_CHANGE_ROWS);
  const hiddenChanges = repository.totalChanges - visibleChanges.length;
  return (
    <section
      aria-label={label}
      className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/40"
    >
      <header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          disabled={repository.totalChanges === 0}
          onClick={() => setExpanded((open) => !open)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-900 hover:text-slate-200 disabled:opacity-30"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        <div className="grid min-w-0 gap-0.5">
          <button
            type="button"
            onClick={() => controls.selectRepository(repository.repositoryRoot)}
            className="min-w-0 truncate text-left text-xs font-medium text-slate-100 hover:text-sky-200"
          >
            {label}
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-slate-300">
              <GitBranch
                aria-hidden="true"
                className="size-3 shrink-0 text-sky-300"
              />
              <span className="min-w-0 truncate">{repository.branch}</span>
            </span>
            {repository.detached ? null : (
              <WorkspaceGitBranchTarget
                branchName={repository.branch}
                parent={repository.parentBranch}
                trunk={repository.defaultBranch}
              />
            )}
            <SyncState repository={repository} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {fetching ? (
            <LoaderCircle
              aria-label="Fetching"
              className="size-3.5 shrink-0 animate-spin text-sky-300"
            />
          ) : null}
          {repository.error ? null : <ChangeSummary repository={repository} />}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => controls.selectRepository(repository.repositoryRoot)}
            className="text-slate-400"
          >
            Open
          </Button>
        </div>
      </header>
      {repository.operation ? (
        <p className="flex items-center gap-1.5 border-t border-amber-900/40 bg-amber-950/20 px-3 py-1.5 text-[11px] text-amber-100">
          <TriangleAlert
            aria-hidden="true"
            className="size-3.5 text-amber-300"
          />
          {OPERATION_LABELS[repository.operation]}
        </p>
      ) : null}
      {repository.error ? (
        <p
          role="alert"
          className="border-t border-red-900/40 px-3 py-1.5 text-[11px] text-red-300"
        >
          {repository.error}
        </p>
      ) : null}
      {expanded && repository.changes.length > 0 ? (
        <ul className="space-y-px border-t border-slate-800/80 p-1">
          {visibleChanges.map((change) => {
            const separator = change.path.lastIndexOf("/");
            const name = change.path.slice(separator + 1);
            const directory =
              separator < 0 ? "" : change.path.slice(0, separator);
            const isSelected =
              selected?.repositoryRoot === repository.repositoryRoot &&
              selected.path === change.path;
            return (
              <li key={change.path}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${change.path}, ${workspaceGitChangeLabel(change)}`}
                  onClick={() =>
                    onSelectChange({
                      repositoryRoot: repository.repositoryRoot,
                      path: change.path,
                    })
                  }
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-slate-900/70 focus-visible:ring-1 focus-visible:ring-sky-500/70",
                    isSelected && "bg-sky-950/40 hover:bg-sky-950/50",
                  )}
                >
                  <code
                    aria-hidden="true"
                    className={cn(
                      "w-3 shrink-0 text-center text-xs font-semibold",
                      changeTone(change),
                    )}
                  >
                    {changeLetter(change)}
                  </code>
                  <span className="min-w-0 truncate text-xs text-slate-200">
                    {name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">
                    {directory}
                  </span>
                </button>
              </li>
            );
          })}
          {hiddenChanges > 0 ? (
            <li>
              <button
                type="button"
                onClick={() =>
                  showAll || visibleChanges.length >= repository.changes.length
                    ? controls.selectRepository(repository.repositoryRoot)
                    : setShowAll(true)
                }
                className="w-full rounded-md px-2 py-1 text-left text-[11px] text-sky-300 hover:bg-slate-900/70"
              >
                {hiddenChanges} more
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
};

export const WorkspaceGitRepositories = ({
  controls,
  onOpenPath,
}: {
  controls: WorkspaceGitControls;
  onOpenPath: (
    workspaceRelativePath: string,
    action: WorkspaceGitPathAction,
  ) => void;
}): JSX.Element | null => {
  const [selected, setSelected] = useState<SelectedChange | null>(null);
  const status = controls.repositoriesStatus;
  if (!status) return null;
  const selectedRepository = selected
    ? status.repositories.find(
        (repository) => repository.repositoryRoot === selected.repositoryRoot,
      )
    : undefined;
  const selectedChange = selectedRepository?.changes.find(
    (change) => change.path === selected?.path,
  );
  const openPath = (action: WorkspaceGitPathAction): void => {
    if (!selectedRepository || !selectedChange) return;
    onOpenPath(
      workspaceGitPathInWorkspace(selectedRepository, selectedChange.path),
      action,
    );
  };
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4",
        selectedChange && "lg:grid-cols-[minmax(18rem,28rem)_minmax(0,1fr)]",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {status.repositories.map((repository) => (
          <RepositoryCard
            key={repository.repositoryRoot}
            repository={repository}
            controls={controls}
            selected={selected}
            onSelectChange={setSelected}
          />
        ))}
      </div>
      {selectedRepository && selectedChange ? (
        <WorkspaceGitDiffView
          workspaceRoot={status.workspaceRoot}
          repositoryRoot={selectedRepository.repositoryRoot}
          change={selectedChange}
          revision={selectedRepository}
          onOpenFile={() => openPath("open")}
          onRevealFile={() => openPath("reveal")}
        />
      ) : null}
    </div>
  );
};
