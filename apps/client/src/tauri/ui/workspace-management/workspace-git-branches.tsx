import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ExternalLink,
  FolderPlus,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Layers,
  ListTree,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import { SearchableSelect } from "@machdoch/media-studio/tauri/ui/components/ui/searchable-select.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  openExternalUrl,
  type WorkspaceGitBranch,
  type WorkspaceGitOverview,
  type WorkspacePullRequest,
} from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import {
  createWorkspaceGitBranchTree,
  filterWorkspaceGitBranches,
  workspaceGitBranchTarget,
  workspaceGitBranchWorktree,
  workspaceGitStackMembers,
  type WorkspaceGitBranchNode,
} from "./workspace-git-model";
import {
  WorkspaceGitResetDialog,
  type WorkspaceGitResetTarget,
} from "./workspace-git-reset-dialog";

const TREE_INDENT_REM = 1;
const TREE_INSET_REM = 0.5;
const TREE_LINE_OFFSET_REM = 0.4375;

const treeColumn = (column: number): string =>
  `${TREE_INSET_REM + column * TREE_INDENT_REM + TREE_LINE_OFFSET_REM}rem`;

const TreeGuides = ({
  node,
}: {
  node: WorkspaceGitBranchNode;
}): JSX.Element | null => {
  if (node.depth === 0) return null;
  const elbow = treeColumn(node.depth - 1);
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0"
    >
      {node.guides.map((line, column) =>
        line ? (
          <span
            key={column}
            className="absolute inset-y-0 w-px bg-slate-700/80"
            style={{ left: treeColumn(column) }}
          />
        ) : null,
      )}
      <span
        className="absolute top-0 w-px bg-slate-700/80"
        style={{ left: elbow, height: node.last ? "50%" : "100%" }}
      />
      <span
        className="absolute top-1/2 h-px bg-slate-700/80"
        style={{ left: elbow, width: `${TREE_INDENT_REM - 0.125}rem` }}
      />
    </span>
  );
};

const NewBranchForm = ({
  overview,
  controls,
}: {
  overview: WorkspaceGitOverview;
  controls: WorkspaceGitControls;
}): JSX.Element => {
  const [name, setName] = useState("");
  const [stacked, setStacked] = useState(false);
  const [startPoint, setStartPoint] = useState("");
  const current = overview.branch;
  const baseOptions = [
    { value: "", label: current ? `${current} (current)` : "HEAD" },
    ...[...overview.localBranches, ...overview.remoteBranches]
      .filter((branch) => branch.name !== current)
      .map((branch) => ({ value: branch.name, label: branch.name })),
  ];
  const create = async (): Promise<void> => {
    const created = stacked
      ? await controls.runAction("create-stacked-branch", { branchName: name })
      : await controls.runAction("create-branch", {
          branchName: name,
          startPoint,
        });
    if (created) {
      setName("");
      setStartPoint("");
    }
  };
  return (
    <SubmitShortcut asChild>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2">
        <Input
          value={name}
          aria-label="New branch name"
          placeholder="New branch"
          onChange={(event) => setName(event.target.value)}
          className="h-8 min-w-40 flex-1 border-slate-800 bg-slate-950 text-xs"
        />
        {stacked ? null : (
          <SearchableSelect
            label="Start point"
            value={startPoint}
            options={baseOptions}
            onChange={setStartPoint}
            className="h-8 w-48 rounded-md border-slate-800 bg-slate-950 text-xs"
          />
        )}
        <label className="flex h-8 items-center gap-2 rounded-md px-2 text-xs text-slate-300 hover:bg-slate-900">
          <input
            type="checkbox"
            checked={stacked}
            disabled={!current || overview.detached}
            onChange={(event) => setStacked(event.target.checked)}
            className="accent-sky-500"
          />
          Stack on {current || "HEAD"}
        </label>
        <Button
          type="button"
          size="sm"
          disabled={controls.busy || !name.trim()}
          onClick={() => void create()}
          {...SUBMIT_SHORTCUT_ACTION_PROPS}
        >
          <Plus className="size-4" />
          Create
        </Button>
      </div>
    </SubmitShortcut>
  );
};

const StackActions = ({
  overview,
  controls,
  stackMembers,
}: {
  overview: WorkspaceGitOverview;
  controls: WorkspaceGitControls;
  stackMembers: readonly string[];
}): JSX.Element | null => {
  const [draft, setDraft] = useState(false);
  if (!overview.branch || overview.detached || stackMembers.length === 0) {
    return null;
  }
  const needsRestack = overview.localBranches.some(
    (branch) => stackMembers.includes(branch.name) && branch.needsRestack,
  );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2">
      <Layers aria-hidden="true" className="size-4 text-violet-300" />
      <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
        Stack · {stackMembers.length + 1} branches
      </span>
      <Button
        type="button"
        size="sm"
        variant={needsRestack ? "default" : "outline"}
        disabled={controls.busy}
        onClick={() => void controls.runAction("restack")}
      >
        <ListTree className="size-4" />
        Restack
      </Button>
      <label className="flex h-8 items-center gap-2 px-1 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={draft}
          onChange={(event) => setDraft(event.target.checked)}
          className="accent-sky-500"
        />
        Draft
      </label>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={
          controls.isActionBlocked("submit-pull-requests") ||
          overview.remotes.length === 0
        }
        tooltip={
          overview.remotes.length === 0 ? "Add a remote first." : undefined
        }
        onClick={() =>
          void controls.runAction("submit-pull-requests", { draft })
        }
      >
        <GitPullRequest className="size-4" />
        Submit stack
      </Button>
    </div>
  );
};

const BranchMenu = ({
  branch,
  current,
  hasWorktree,
  controls,
  onReset,
}: {
  branch: WorkspaceGitBranch;
  current: string;
  hasWorktree: boolean;
  controls: WorkspaceGitControls;
  onReset: (target: WorkspaceGitResetTarget) => void;
}): JSX.Element | null => {
  const isCurrent = branch.name === current;
  const resetTarget = isCurrent
    ? branch.upstream && !branch.upstreamGone
      ? branch.upstream
      : null
    : branch.name;
  if (isCurrent && !branch.parent && !resetTarget) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`More actions for ${branch.name}`}
          tooltip={null}
          disabled={controls.busy}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {!isCurrent && !hasWorktree ? (
          <>
            <DropdownMenuItem
              onSelect={() =>
                void controls.runAction("add-worktree", {
                  branchName: branch.name,
                })
              }
            >
              <FolderPlus className="size-3.5" />
              Create worktree
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {!isCurrent && current ? (
          <>
            <DropdownMenuItem
              onSelect={() =>
                void controls.runAction("merge", { branchName: branch.name })
              }
            >
              <GitMerge className="size-3.5" />
              Merge into {current}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void controls.runAction("rebase", { branchName: branch.name })
              }
            >
              <ArrowDownToLine className="size-3.5" />
              Rebase {current} onto this
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {branch.parent !== current ? (
              <DropdownMenuItem
                onSelect={() =>
                  void controls.runAction("stack-branch", {
                    branchName: branch.name,
                    parentBranch: current,
                  })
                }
              >
                <Layers className="size-3.5" />
                Stack on {current}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() =>
                void controls.runAction("stack-branch", {
                  branchName: current,
                  parentBranch: branch.name,
                })
              }
            >
              <CornerDownRight className="size-3.5" />
              Stack {current} on this
            </DropdownMenuItem>
          </>
        ) : null}
        {branch.parent ? (
          <DropdownMenuItem
            onSelect={() =>
              void controls.runAction("unstack-branch", {
                branchName: branch.name,
              })
            }
          >
            <Unlink className="size-3.5" />
            Remove from stack
          </DropdownMenuItem>
        ) : null}
        {resetTarget && current ? (
          <DropdownMenuItem
            onSelect={() =>
              onReset({ revision: resetTarget, label: resetTarget })
            }
          >
            <RotateCcw className="size-3.5" />
            {isCurrent
              ? `Reset to ${resetTarget}…`
              : `Reset ${current} to this…`}
          </DropdownMenuItem>
        ) : null}
        {!isCurrent ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                if (window.confirm(`Delete branch ${branch.name}?`)) {
                  void controls.runAction("delete-branch", {
                    branchName: branch.name,
                  });
                }
              }}
            >
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const BranchRow = ({
  node,
  current,
  trunk,
  dirty,
  pullRequest,
  hasWorktree,
  controls,
  onReset,
}: {
  node: WorkspaceGitBranchNode;
  current: string;
  trunk: string | undefined;
  dirty: boolean;
  pullRequest: WorkspacePullRequest | undefined;
  hasWorktree: boolean;
  controls: WorkspaceGitControls;
  onReset: (target: WorkspaceGitResetTarget) => void;
}): JSX.Element => {
  const { branch, depth } = node;
  const isCurrent = branch.name === current;
  const BranchIcon = node.nested ? Layers : GitBranch;
  return (
    <li
      className={cn(
        "group relative flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-1 hover:bg-slate-900/70",
        isCurrent && "bg-sky-950/30",
      )}
      style={{
        paddingLeft: `${TREE_INSET_REM + depth * TREE_INDENT_REM}rem`,
      }}
    >
      <TreeGuides node={node} />
      <BranchIcon
        aria-label={node.nested ? `Nested on ${node.base}` : undefined}
        aria-hidden={node.nested ? undefined : true}
        className={cn(
          "relative size-3.5 shrink-0",
          isCurrent
            ? "text-sky-300"
            : node.nested
              ? "text-violet-300"
              : "text-slate-500",
        )}
      />
      <span
        title={node.nested ? `Nested on ${node.base}` : undefined}
        className={cn(
          "min-w-0 truncate text-xs",
          isCurrent ? "font-medium text-sky-100" : "text-slate-200",
        )}
      >
        {branch.name}
      </span>
      {branch.name === trunk ? (
        <span className="shrink-0 rounded-full border border-slate-700 px-1.5 text-[10px] text-slate-400">
          default
        </span>
      ) : null}
      {branch.ahead ? (
        <span className="text-[10px] text-emerald-300">↑{branch.ahead}</span>
      ) : null}
      {branch.behind ? (
        <span className="text-[10px] text-amber-300">↓{branch.behind}</span>
      ) : null}
      {branch.upstreamGone ? <Badge variant="outline">gone</Badge> : null}
      {branch.needsRestack ? (
        <span title="Parent moved" className="inline-flex text-amber-300">
          <TriangleAlert aria-label="Needs restack" className="size-3.5" />
        </span>
      ) : null}
      {pullRequest ? (
        <button
          type="button"
          onClick={() => void openExternalUrl(pullRequest.url)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-800/60 px-1.5 text-[10px] text-emerald-300 hover:bg-emerald-950/40"
        >
          #{pullRequest.number}
          {pullRequest.draft ? " draft" : ""}
          <ExternalLink aria-hidden="true" className="size-2.5" />
        </button>
      ) : null}
      <span className="flex-1" />
      {isCurrent ? (
        <span className="px-2 text-[10px] uppercase tracking-wide text-sky-300">
          Current
        </span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={controls.busy}
          onClick={() => void controls.switchBranch(branch.name)}
          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          {dirty ? "Stash & switch" : "Switch"}
        </Button>
      )}
      <BranchMenu
        branch={branch}
        current={current}
        hasWorktree={hasWorktree}
        controls={controls}
        onReset={onReset}
      />
    </li>
  );
};

export const WorkspaceGitBranches = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const [query, setQuery] = useState("");
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [resetTarget, setResetTarget] =
    useState<WorkspaceGitResetTarget | null>(null);
  const {
    ensurePullRequests,
    pullRequests,
    pullRequestsError,
    pullRequestsLoading,
  } = controls;
  useEffect(() => {
    if (!pullRequests && !pullRequestsLoading && !pullRequestsError) {
      ensurePullRequests();
    }
  }, [
    ensurePullRequests,
    pullRequests,
    pullRequestsError,
    pullRequestsLoading,
  ]);

  const current = overview.detached ? "" : overview.branch;
  const stackMembers = current
    ? workspaceGitStackMembers(overview.localBranches, current)
    : [];
  const filteredLocal = filterWorkspaceGitBranches(
    overview.localBranches,
    query,
  );
  const trunk = overview.defaultBranch;
  const nodes: WorkspaceGitBranchNode[] = query.trim()
    ? filteredLocal.map((branch) => ({
        branch,
        depth: 0,
        guides: [],
        last: true,
        ...workspaceGitBranchTarget(branch.name, branch.parent, trunk),
      }))
    : createWorkspaceGitBranchTree(overview.localBranches, trunk);
  const remoteBranches = filterWorkspaceGitBranches(
    overview.remoteBranches,
    query,
  );
  const pullRequestFor = (name: string): WorkspacePullRequest | undefined =>
    pullRequests?.items.find((item) => item.headBranch === name);

  return (
    <div className="space-y-3">
      <NewBranchForm
        key={overview.repositoryRoot}
        overview={overview}
        controls={controls}
      />
      <StackActions
        overview={overview}
        controls={controls}
        stackMembers={stackMembers}
      />
      <SearchField
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Filter branches"
        placeholder="Filter branches"
        className="h-8 border-slate-800 bg-slate-950 text-xs"
      />
      <section aria-label="Local branches">
        <ul>
          {nodes.map((node) => (
            <BranchRow
              key={node.branch.name}
              node={node}
              current={current}
              trunk={trunk}
              dirty={!overview.clean}
              pullRequest={pullRequestFor(node.branch.name)}
              hasWorktree={Boolean(
                workspaceGitBranchWorktree(overview, node.branch.name),
              )}
              controls={controls}
              onReset={setResetTarget}
            />
          ))}
        </ul>
      </section>
      {remoteBranches.length > 0 ? (
        <section
          aria-label="Remote branches"
          className="border-t border-slate-800 pt-2"
        >
          <button
            type="button"
            aria-expanded={remotesOpen || query.trim().length > 0}
            onClick={() => setRemotesOpen((open) => !open)}
            className="flex h-7 w-full items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
          >
            {remotesOpen || query.trim() ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Remote
            <span className="rounded-full bg-slate-800 px-1.5 text-[10px] normal-case text-slate-400">
              {remoteBranches.length}
            </span>
          </button>
          {remotesOpen || query.trim() ? (
            <ul className="space-y-px">
              {remoteBranches.map((branch) => (
                <li
                  key={branch.name}
                  className="group flex min-w-0 items-center gap-2 rounded-md py-1.5 pl-2 pr-1 hover:bg-slate-900/70"
                >
                  <GitBranch
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-slate-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                    {branch.name}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={controls.busy}
                    onClick={() =>
                      void controls.runAction("checkout-remote", {
                        branchName: branch.name,
                      })
                    }
                    className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    Check out
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {resetTarget && current ? (
        <WorkspaceGitResetDialog
          controls={controls}
          branch={current}
          target={resetTarget}
          onClose={() => setResetTarget(null)}
        />
      ) : null}
    </div>
  );
};
