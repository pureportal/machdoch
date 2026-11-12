import {
  Copy,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Lock,
  LockOpen,
  Trash2,
  Unplug,
} from "lucide-react";
import { useId, useState, type JSX } from "react";
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { SearchableSelect } from "@machdoch/media-studio/tauri/ui/components/ui/searchable-select.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import type { WorkspaceGitOverview, WorkspaceGitWorktree } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import {
  workspaceGitWorktreeBranches,
  workspaceGitWorktreeLabel,
} from "./workspace-git-model";

const NewWorktreeForm = ({
  overview,
  controls,
}: {
  overview: WorkspaceGitOverview;
  controls: WorkspaceGitControls;
}): JSX.Element => {
  const listId = useId();
  const [branchName, setBranchName] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const name = branchName.trim();
  const existing =
    overview.localBranches.some((branch) => branch.name === name) ||
    overview.remoteBranches.some((branch) => branch.name.endsWith(`/${name}`));
  const baseOptions = [
    {
      value: "",
      label: overview.branch ? `${overview.branch} (current)` : "HEAD",
    },
    ...overview.localBranches
      .filter((branch) => branch.name !== overview.branch)
      .map((branch) => ({ value: branch.name, label: branch.name })),
  ];
  const create = async (): Promise<void> => {
    const created = await controls.runAction("add-worktree", {
      branchName: name,
      ...(startPoint && !existing ? { startPoint } : {}),
    });
    if (created) {
      setBranchName("");
      setStartPoint("");
    }
  };
  return (
    <SubmitShortcut asChild>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2">
        <Input
          value={branchName}
          list={listId}
          aria-label="Worktree branch"
          placeholder="Branch"
          onChange={(event) => setBranchName(event.target.value)}
          className="h-8 min-w-40 flex-1 border-slate-800 bg-slate-950 text-xs"
        />
        <datalist id={listId}>
          {workspaceGitWorktreeBranches(overview).map((branch) => (
            <option key={branch} value={branch} />
          ))}
        </datalist>
        {name && !existing ? (
          <SearchableSelect
            label="Start point"
            value={startPoint}
            options={baseOptions}
            onChange={setStartPoint}
            className="h-8 w-48 rounded-md border-slate-800 bg-slate-950 text-xs"
          />
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={controls.busy || !name}
          onClick={() => void create()}
          {...SUBMIT_SHORTCUT_ACTION_PROPS}
        >
          {controls.pendingAction === "add-worktree" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <FolderPlus className="size-4" />
          )}
          Create worktree
        </Button>
      </div>
    </SubmitShortcut>
  );
};

const WorktreeRow = ({
  worktree,
  controls,
  onOpenWorktree,
}: {
  worktree: WorkspaceGitWorktree;
  controls: WorkspaceGitControls;
  onOpenWorktree?: (path: string) => void;
}): JSX.Element => {
  const label = workspaceGitWorktreeLabel(worktree);
  const changes = worktree.changes ?? 0;
  const remove = (): void => {
    const message =
      changes > 0
        ? `Remove the worktree for ${label}? Its ${changes} uncommitted change${changes === 1 ? "" : "s"} will be lost. The branch stays.`
        : `Remove the worktree for ${label}? The branch stays.`;
    if (window.confirm(message)) {
      void controls.runAction("remove-worktree", {
        worktreePath: worktree.path,
        force: changes > 0,
      });
    }
  };
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <FolderGit2
        aria-hidden="true"
        className="size-4 shrink-0 text-slate-500"
      />
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex min-w-0 items-center gap-2 text-xs text-slate-200">
          <span className="truncate font-medium">{label}</span>
          {worktree.main ? <Badge variant="outline">primary</Badge> : null}
          {worktree.current ? <Badge variant="outline">current</Badge> : null}
          {worktree.locked ? (
            <Badge variant="outline" title={worktree.lockReason}>
              locked
            </Badge>
          ) : null}
          {worktree.prunable ? <Badge variant="outline">missing</Badge> : null}
          {changes > 0 ? (
            <span className="shrink-0 text-[11px] text-amber-300">
              {changes} change{changes === 1 ? "" : "s"}
            </span>
          ) : null}
        </p>
        <p
          className="mt-0.5 truncate text-[11px] text-slate-500"
          title={worktree.path}
        >
          {worktree.path}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onOpenWorktree && !worktree.current && !worktree.prunable ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={controls.busy}
            onClick={() => onOpenWorktree(worktree.path)}
          >
            <FolderOpen />
            Open
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Copy path of ${label}`}
          onClick={() => void navigator.clipboard.writeText(worktree.path)}
        >
          <Copy />
        </Button>
        {worktree.main ? null : (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${worktree.locked ? "Unlock" : "Lock"} ${label}`}
            disabled={controls.busy || worktree.prunable}
            onClick={() =>
              void controls.runAction(
                worktree.locked ? "unlock-worktree" : "lock-worktree",
                { worktreePath: worktree.path },
              )
            }
          >
            {worktree.locked ? <LockOpen /> : <Lock />}
          </Button>
        )}
        {worktree.main || worktree.current ? null : (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove worktree ${label}`}
            disabled={controls.busy || worktree.locked || worktree.prunable}
            onClick={remove}
          >
            <Trash2 className="text-red-300" />
          </Button>
        )}
      </div>
    </li>
  );
};

export const WorkspaceGitWorktrees = ({
  controls,
  overview,
  onOpenWorktree,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  onOpenWorktree?: (path: string) => void;
}): JSX.Element => (
  <div className="space-y-3">
    <NewWorktreeForm overview={overview} controls={controls} />
    {overview.worktrees.some((worktree) => worktree.prunable) ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={controls.busy}
        onClick={() => void controls.runAction("prune-worktrees")}
      >
        <Unplug className="size-4" />
        Prune missing worktrees
      </Button>
    ) : null}
    {overview.worktrees.length <= 1 ? (
      <EmptyState icon={FolderGit2} title="No other worktrees" size="compact" />
    ) : (
      <ul className="space-y-1">
        {overview.worktrees.map((worktree) => (
          <WorktreeRow
            key={worktree.path}
            worktree={worktree}
            controls={controls}
            onOpenWorktree={onOpenWorktree}
          />
        ))}
      </ul>
    )}
  </div>
);
