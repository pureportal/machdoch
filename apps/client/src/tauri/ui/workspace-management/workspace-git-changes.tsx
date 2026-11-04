import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import {
  Check,
  ExternalLink,
  GitCommitHorizontal,
  LoaderCircle,
  Minus,
  Plus,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceGitChange, WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { WorkspaceGitDiffView } from "./workspace-git-diff";
import {
  groupWorkspaceGitChanges,
  workspaceGitChangeLabel,
} from "./workspace-git-model";

export type WorkspaceGitPathAction = "open" | "reveal";

const statusTone = (change: WorkspaceGitChange): string => {
  if (change.conflicted) return "text-red-300";
  if (change.untracked) return "text-emerald-300";
  if (change.status.includes("D")) return "text-rose-300";
  if (change.status.includes("R")) return "text-violet-300";
  return "text-amber-300";
};

const statusLetter = (change: WorkspaceGitChange, staged: boolean): string => {
  if (change.conflicted) return "!";
  if (change.untracked) return "U";
  const code = staged ? change.status[0] : change.status[1];
  return code && code !== " " ? code : (change.status.trim()[0] ?? "M");
};

const splitPath = (path: string): [string, string] => {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? [path, ""]
    : [path.slice(separator + 1), path.slice(0, separator)];
};

const ChangeRow = ({
  change,
  staged,
  selected,
  busy,
  onSelect,
  onToggleStage,
  onOpen,
}: {
  change: WorkspaceGitChange;
  staged: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggleStage: () => void;
  onOpen: () => void;
}): JSX.Element => {
  const [name, directory] = splitPath(change.path);
  return (
    <li
      className={cn(
        "group flex min-w-0 items-center rounded-md hover:bg-slate-900/70",
        selected && "bg-sky-950/40 hover:bg-sky-950/50",
      )}
    >
      <CopyContextMenu
        selectable={false}
        values={[
          { label: "Copy relative path", value: change.path },
          ...(change.originalPath
            ? [{ label: "Copy original path", value: change.originalPath }]
            : []),
        ]}
      >
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`${change.path}, ${workspaceGitChangeLabel(change)}`}
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-sky-500/70"
        >
          <code
            aria-hidden="true"
            className={cn(
              "w-3 shrink-0 text-center text-xs font-semibold",
              statusTone(change),
            )}
          >
            {statusLetter(change, staged)}
          </code>
          <span className="min-w-0 truncate text-xs text-slate-200">
            {name}
          </span>
          {directory ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">
              {directory}
            </span>
          ) : (
            <span className="flex-1" />
          )}
        </button>
      </CopyContextMenu>
      <div className="flex shrink-0 items-center pr-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Open ${change.path}`}
          disabled={change.status.includes("D")}
          onClick={onOpen}
        >
          <ExternalLink />
        </Button>
        {change.conflicted ? null : (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${staged ? "Unstage" : "Stage"} ${change.path}`}
            disabled={busy}
            onClick={onToggleStage}
          >
            {staged ? <Minus /> : <Plus />}
          </Button>
        )}
      </div>
    </li>
  );
};

const ChangeGroup = ({
  title,
  changes,
  staged,
  selectedPath,
  busy,
  actionLabel,
  onAction,
  onSelect,
  onToggleStage,
  onOpen,
}: {
  title: string;
  changes: readonly WorkspaceGitChange[];
  staged: boolean;
  selectedPath: string | null;
  busy: boolean;
  actionLabel?: string;
  onAction?: () => void;
  onSelect: (path: string) => void;
  onToggleStage: (change: WorkspaceGitChange) => void;
  onOpen: (path: string) => void;
}): JSX.Element | null =>
  changes.length === 0 ? null : (
    <section aria-label={title} className="min-w-0">
      <header className="flex h-7 items-center gap-2 px-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </h4>
        <span className="rounded-full bg-slate-800 px-1.5 text-[10px] text-slate-400">
          {changes.length}
        </span>
        <span className="flex-1" />
        {actionLabel && onAction ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={onAction}
            className="text-slate-400"
          >
            {staged ? <Minus /> : <Plus />}
            {actionLabel}
          </Button>
        ) : null}
      </header>
      <ul className="space-y-px">
        {changes.map((change) => (
          <ChangeRow
            key={`${staged ? "staged" : "worktree"}:${change.path}`}
            change={change}
            staged={staged}
            selected={selectedPath === change.path}
            busy={busy}
            onSelect={() => onSelect(change.path)}
            onToggleStage={() => onToggleStage(change)}
            onOpen={() => onOpen(change.path)}
          />
        ))}
      </ul>
    </section>
  );

const CommitBox = ({
  overview,
  controls,
}: {
  overview: WorkspaceGitOverview;
  controls: WorkspaceGitControls;
}): JSX.Element => {
  const [message, setMessage] = useState("");
  const committing = controls.pendingAction === "commit";
  const stageFirst = overview.stagedCount === 0;
  const unavailable =
    overview.conflictedCount > 0
      ? "Resolve conflicts before committing."
      : null;
  const commit = async (): Promise<void> => {
    if (stageFirst && !(await controls.runAction("stage-all"))) return;
    if (await controls.runAction("commit", { message })) setMessage("");
  };
  return (
    <SubmitShortcut asChild>
      <div className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2">
        <Textarea
          value={message}
          aria-label="Commit message"
          placeholder={`Message (${overview.branch || "HEAD"})`}
          rows={2}
          disabled={unavailable !== null}
          onChange={(event) => setMessage(event.target.value)}
          className="min-h-14 resize-y border-slate-800 bg-slate-950 text-xs"
        />
        <Button
          type="button"
          size="sm"
          disabled={controls.busy || unavailable !== null || !message.trim()}
          tooltip={unavailable ?? undefined}
          onClick={() => void commit()}
          {...SUBMIT_SHORTCUT_ACTION_PROPS}
        >
          {committing ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <GitCommitHorizontal className="size-4" />
          )}
          {stageFirst ? "Stage all & commit" : "Commit"}
        </Button>
      </div>
    </SubmitShortcut>
  );
};

export const WorkspaceGitChanges = ({
  controls,
  overview,
  onOpenPath,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  onOpenPath: (path: string, action: WorkspaceGitPathAction) => void;
}): JSX.Element => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const groups = groupWorkspaceGitChanges(overview.changes);
  const selectedChange =
    overview.changes.find((change) => change.path === selectedPath) ??
    groups.conflicts[0] ??
    groups.staged[0] ??
    groups.unstaged[0] ??
    null;

  useEffect(() => {
    setSelectedPath(null);
  }, [overview.repositoryRoot]);

  const toggleStage = (change: WorkspaceGitChange, staged: boolean): void => {
    void controls.runAction(staged ? "unstage" : "stage", {
      paths: [change.path],
    });
  };

  return (
    <div
      className={cn(
        "grid min-w-0 gap-4",
        selectedChange && "lg:grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)]",
      )}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {overview.clean ? (
          <EmptyState icon={Check} title="Working tree clean" size="compact" />
        ) : (
          <div className="space-y-3">
            <CommitBox
              key={overview.repositoryRoot}
              overview={overview}
              controls={controls}
            />
            <ChangeGroup
              title="Conflicts"
              changes={groups.conflicts}
              staged={false}
              selectedPath={selectedChange?.path ?? null}
              busy={controls.busy}
              actionLabel={
                groups.conflicts.length ? "Mark resolved" : undefined
              }
              onAction={() =>
                void controls.runAction("stage", {
                  paths: groups.conflicts.map((change) => change.path),
                })
              }
              onSelect={setSelectedPath}
              onToggleStage={(change) => toggleStage(change, false)}
              onOpen={(path) => onOpenPath(path, "open")}
            />
            <ChangeGroup
              title="Staged"
              changes={groups.staged}
              staged
              selectedPath={selectedChange?.path ?? null}
              busy={controls.busy}
              actionLabel="Unstage all"
              onAction={() => void controls.runAction("unstage-all")}
              onSelect={setSelectedPath}
              onToggleStage={(change) => toggleStage(change, true)}
              onOpen={(path) => onOpenPath(path, "open")}
            />
            <ChangeGroup
              title="Changes"
              changes={groups.unstaged}
              staged={false}
              selectedPath={selectedChange?.path ?? null}
              busy={controls.busy}
              actionLabel="Stage all"
              onAction={() => void controls.runAction("stage-all")}
              onSelect={setSelectedPath}
              onToggleStage={(change) => toggleStage(change, false)}
              onOpen={(path) => onOpenPath(path, "open")}
            />
            {overview.changesTruncated ? (
              <p className="px-2 text-xs text-slate-500">
                Showing {overview.changes.length} of {overview.totalChanges}
              </p>
            ) : null}
          </div>
        )}
      </div>
      {selectedChange ? (
        <WorkspaceGitDiffView
          workspaceRoot={overview.workspaceRoot}
          repositoryRoot={overview.repositoryRoot}
          change={selectedChange}
          revision={overview}
          onOpenFile={() => onOpenPath(selectedChange.path, "open")}
          onRevealFile={() => onOpenPath(selectedChange.path, "reveal")}
        />
      ) : null}
    </div>
  );
};
