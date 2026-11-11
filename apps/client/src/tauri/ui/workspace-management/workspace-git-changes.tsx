import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import {
  Check,
  ExternalLink,
  GitCommitHorizontal,
  LoaderCircle,
  Minus,
  Plus,
} from "lucide-react";
import { useEffect, useState, type JSX, type KeyboardEvent } from "react";
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
import { prefetchWorkspaceGitDiff } from "./workspace-git-diff-cache";
import { WorkspaceGitLineStats } from "./workspace-git-line-stats";
import {
  groupWorkspaceGitChanges,
  workspaceGitChangeLabel,
} from "./workspace-git-model";

export type WorkspaceGitPathAction = "open" | "reveal";

const ROW_SELECTOR = "[data-git-change-row]";

const statusTone = (change: WorkspaceGitChange): string => {
  if (change.conflicted) return "text-rose-400";
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

const lineTotals = (
  changes: readonly WorkspaceGitChange[],
): { additions: number; deletions: number } =>
  changes.reduce(
    (totals, change) => ({
      additions: totals.additions + (change.additions ?? 0),
      deletions: totals.deletions + (change.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );

const ChangeRow = ({
  change,
  staged,
  selected,
  busy,
  onSelect,
  onPrefetch,
  onToggleStage,
  onOpen,
}: {
  change: WorkspaceGitChange;
  staged: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onPrefetch: () => void;
  onToggleStage: () => void;
  onOpen: () => void;
}): JSX.Element => {
  const [name, directory] = splitPath(change.path);
  return (
    <li
      onPointerEnter={onPrefetch}
      className={cn(
        "group flex min-w-0 items-center rounded-md hover:bg-(--app-hover)",
        selected && "bg-sky-500/15 hover:bg-sky-500/20",
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
          data-git-change-row=""
          aria-pressed={selected}
          aria-label={`${change.path}, ${workspaceGitChangeLabel(change)}`}
          onClick={onSelect}
          onFocus={onPrefetch}
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
          <WorkspaceGitLineStats
            additions={change.additions}
            deletions={change.deletions}
            className="group-hover:hidden group-focus-within:hidden"
          />
        </button>
      </CopyContextMenu>
      <div className="hidden shrink-0 items-center pr-1 group-focus-within:flex group-hover:flex">
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
  onPrefetch,
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
  onPrefetch: (path: string) => void;
  onToggleStage: (change: WorkspaceGitChange) => void;
  onOpen: (path: string) => void;
}): JSX.Element | null => {
  if (changes.length === 0) return null;
  const totals = lineTotals(changes);
  return (
    <section aria-label={title} className="min-w-0">
      <header className="flex h-7 items-center gap-2 px-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </h4>
        <span className="rounded-full bg-slate-800 px-1.5 text-[10px] text-slate-400">
          {changes.length}
        </span>
        <WorkspaceGitLineStats
          additions={totals.additions}
          deletions={totals.deletions}
          blocks
        />
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
            onPrefetch={() => onPrefetch(change.path)}
            onToggleStage={() => onToggleStage(change)}
            onOpen={() => onOpen(change.path)}
          />
        ))}
      </ul>
    </section>
  );
};

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

const moveRowFocus = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  if (index === -1) return;
  const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
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
  const ordered = [...groups.conflicts, ...groups.staged, ...groups.unstaged];
  const selectedChange =
    overview.changes.find((change) => change.path === selectedPath) ??
    ordered[0] ??
    null;
  const prefetch = (path: string): void =>
    prefetchWorkspaceGitDiff(
      overview.workspaceRoot,
      overview.repositoryRoot,
      path,
      overview,
    );

  useEffect(() => {
    setSelectedPath(null);
  }, [overview.repositoryRoot]);

  const selectedIndex = selectedChange
    ? ordered.findIndex((change) => change.path === selectedChange.path)
    : -1;
  const neighbors = [ordered[selectedIndex - 1], ordered[selectedIndex + 1]]
    .flatMap((change) => (change ? [change.path] : []))
    .join("\n");
  useEffect(() => {
    for (const path of neighbors.split("\n").filter(Boolean)) {
      prefetchWorkspaceGitDiff(
        overview.workspaceRoot,
        overview.repositoryRoot,
        path,
        overview,
      );
    }
  }, [neighbors, overview]);

  const toggleStage = (change: WorkspaceGitChange, staged: boolean): void => {
    void controls.runAction(staged ? "unstage" : "stage", {
      paths: [change.path],
    });
  };

  const groupProps = {
    selectedPath: selectedChange?.path ?? null,
    busy: controls.busy,
    onSelect: setSelectedPath,
    onPrefetch: prefetch,
    onOpen: (path: string) => onOpenPath(path, "open"),
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
          <div className="space-y-3" onKeyDown={moveRowFocus}>
            <CommitBox
              key={overview.repositoryRoot}
              overview={overview}
              controls={controls}
            />
            <ChangeGroup
              {...groupProps}
              title="Conflicts"
              changes={groups.conflicts}
              staged={false}
              actionLabel={
                groups.conflicts.length ? "Mark resolved" : undefined
              }
              onAction={() =>
                void controls.runAction("stage", {
                  paths: groups.conflicts.map((change) => change.path),
                })
              }
              onToggleStage={(change) => toggleStage(change, false)}
            />
            <ChangeGroup
              {...groupProps}
              title="Staged"
              changes={groups.staged}
              staged
              actionLabel="Unstage all"
              onAction={() => void controls.runAction("unstage-all")}
              onToggleStage={(change) => toggleStage(change, true)}
            />
            <ChangeGroup
              {...groupProps}
              title="Changes"
              changes={groups.unstaged}
              staged={false}
              actionLabel="Stage all"
              onAction={() => void controls.runAction("stage-all")}
              onToggleStage={(change) => toggleStage(change, false)}
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
