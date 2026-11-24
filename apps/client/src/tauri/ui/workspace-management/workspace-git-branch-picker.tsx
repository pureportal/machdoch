import {
  Brush,
  Check,
  ChevronsUpDown,
  GitBranch,
  Layers,
  Plus,
} from "lucide-react";
import { useMemo, useRef, useState, type JSX } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@machdoch/media-studio/tauri/ui/components/ui/command.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import type { CloudIssueReference } from "./workspace-cloud-issues";
import { WorkspaceGitBranchCleanup } from "./workspace-git-branch-cleanup";
import {
  branchNameForIssue,
  changeCountTooltip,
  commitAge,
  groupBranches,
  issueKeyFromBranch,
  type BranchCandidate,
  type RankedBranch,
} from "./workspace-git-branch-search";
import {
  BranchIssue,
  useBranchIssues,
  useIssueSearch,
} from "./workspace-git-issue-branches";
import { listWorkspaceGitBranches } from "./workspace-tools-runtime";

const recentBranchCache = new Map<string, string[]>();

const branchCandidates = (
  overview: WorkspaceGitOverview,
): BranchCandidate[] => [
  ...overview.localBranches.map((branch) => ({
    name: branch.name,
    remote: false,
    current: branch.current,
    ahead: branch.ahead,
    behind: branch.behind,
    upstreamGone: branch.upstreamGone,
    lastCommitAt: branch.lastCommitAt,
    merged: branch.merged,
  })),
  ...overview.remoteBranches.map((branch) => ({
    name: branch.name,
    remote: true,
    current: false,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    lastCommitAt: branch.lastCommitAt,
  })),
];

const BranchRow = ({
  branch,
  stacked,
  now,
  issues,
}: {
  branch: RankedBranch;
  stacked: boolean;
  now: number;
  issues: ReadonlyMap<string, CloudIssueReference>;
}): JSX.Element => {
  const age = commitAge(branch.lastCommitAt, now);
  const issueKey = issueKeyFromBranch(branch.name);
  return (
    <>
      <GitBranch
        className={cn(
          "size-3.5",
          branch.remote ? "text-slate-600" : "text-slate-500",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          branch.remote && "text-slate-400",
        )}
      >
        {branch.name}
      </span>
      {issueKey ? (
        <BranchIssue issueKey={issueKey} issue={issues.get(issueKey)} />
      ) : null}
      {stacked ? (
        <Layers aria-label="Stacked" className="size-3 text-violet-300/70" />
      ) : null}
      {branch.ahead ? (
        <span
          aria-label={`${branch.ahead} ahead`}
          className="text-[10px] text-emerald-300"
        >
          ↑{branch.ahead}
        </span>
      ) : null}
      {branch.behind ? (
        <span
          aria-label={`${branch.behind} behind`}
          className="text-[10px] text-amber-300"
        >
          ↓{branch.behind}
        </span>
      ) : null}
      {branch.upstreamGone ? (
        <span className="text-[10px] text-slate-500">gone</span>
      ) : null}
      {age ? (
        <time
          dateTime={branch.lastCommitAt}
          className="w-8 shrink-0 text-right text-[10px] text-slate-500"
        >
          {age}
        </time>
      ) : null}
      {branch.current ? <Check className="size-3.5 text-sky-400" /> : null}
    </>
  );
};

export const WorkspaceGitBranchPicker = ({
  controls,
  overview,
  className,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  className?: string;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(
    () => recentBranchCache.get(overview.repositoryRoot) ?? [],
  );
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const current = overview.detached ? "" : overview.branch;
  const draftName = query.trim();
  const canCreate =
    draftName.length > 0 &&
    !overview.localBranches.some((branch) => branch.name === draftName);
  const candidates = useMemo(() => branchCandidates(overview), [overview]);
  const groups = useMemo(
    () => groupBranches(candidates, recent, query),
    [candidates, query, recent],
  );
  const parents = useMemo(
    () =>
      new Set(
        overview.localBranches
          .filter((branch) => branch.parent)
          .map((branch) => branch.name),
      ),
    [overview.localBranches],
  );
  const shownBranches = useMemo(
    () =>
      [...groups.recent, ...groups.local, ...groups.remote].map(
        (branch) => branch.name,
      ),
    [groups],
  );
  const branchIssues = useBranchIssues(
    overview.workspaceRoot,
    shownBranches,
    open,
  );
  const localNames = useMemo(
    () => new Set(overview.localBranches.map((branch) => branch.name)),
    [overview.localBranches],
  );
  const issueBranches = useIssueSearch(overview.workspaceRoot, query, open)
    .map((issue) => ({
      issue,
      name: branchNameForIssue(issue.identifier, issue.title),
    }))
    .filter((entry) => !localNames.has(entry.name))
    .slice(0, 6);

  const loadRecent = (): void => {
    void listWorkspaceGitBranches(
      overview.workspaceRoot,
      overview.repositoryRoot,
    )
      .then((list) => {
        recentBranchCache.set(overview.repositoryRoot, list.recentBranches);
        setRecent(list.recentBranches);
      })
      .catch((error: unknown) =>
        console.error("Loading recent branches failed", error),
      );
  };

  const choose = (run: () => Promise<boolean>): void => {
    setOpen(false);
    setQuery("");
    void run();
  };

  const branchItem = (branch: RankedBranch, group: string): JSX.Element => (
    <CommandItem
      key={`${group}:${branch.name}`}
      value={`${group}:${branch.name}`}
      disabled={branch.current}
      onSelect={() =>
        choose(() =>
          branch.remote
            ? controls.runAction("checkout-remote", { branchName: branch.name })
            : controls.switchBranch(branch.name),
        )
      }
    >
      <BranchRow
        branch={branch}
        stacked={parents.has(branch.name)}
        now={now}
        issues={branchIssues}
      />
    </CommandItem>
  );

  return (
    <>
      <Popover
        modal
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setNow(Date.now());
            loadRecent();
          } else {
            setQuery("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Branch ${overview.branch || "detached HEAD"}`}
            disabled={controls.busy}
            className={cn(
              "flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md border border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-100 outline-none hover:border-slate-500 focus-visible:border-sky-400 disabled:opacity-50",
              className,
            )}
          >
            <GitBranch
              aria-hidden="true"
              className="size-3.5 shrink-0 text-sky-300"
            />
            <span className="min-w-0 truncate font-medium">
              {overview.detached
                ? `${overview.branch} (detached)`
                : overview.branch}
            </span>
            {overview.totalChanges > 0 ? (
              <span
                title={changeCountTooltip({
                  staged: overview.stagedCount,
                  unstaged: overview.unstagedCount,
                  untracked: overview.untrackedCount,
                  conflicted: overview.conflictedCount,
                })}
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-[10px] leading-4",
                  overview.conflictedCount
                    ? "bg-red-500/15 text-red-300"
                    : "bg-amber-500/15 text-amber-200",
                )}
              >
                {overview.totalChanges}
              </span>
            ) : null}
            <ChevronsUpDown
              aria-hidden="true"
              className="size-3 shrink-0 text-slate-500"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(28rem,calc(100vw-2rem))] p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Command shouldFilter={false}>
            <CommandInput
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              aria-label="Search or create branch"
              placeholder="Switch or create branch…"
            />
            <CommandList>
              <CommandEmpty>No branches</CommandEmpty>
              {canCreate ? (
                <CommandGroup heading="Create">
                  <CommandItem
                    value={`create:${draftName}`}
                    onSelect={() =>
                      choose(() =>
                        controls.runAction("create-branch", {
                          branchName: draftName,
                        }),
                      )
                    }
                  >
                    <Plus className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      Create <strong>{draftName}</strong>
                    </span>
                  </CommandItem>
                  {current ? (
                    <CommandItem
                      value={`stack:${draftName}`}
                      onSelect={() =>
                        choose(() =>
                          controls.runAction("create-stacked-branch", {
                            branchName: draftName,
                          }),
                        )
                      }
                    >
                      <Layers className="size-3.5 text-violet-300" />
                      <span className="min-w-0 flex-1 truncate">
                        Create <strong>{draftName}</strong> stacked on {current}
                      </span>
                    </CommandItem>
                  ) : null}
                </CommandGroup>
              ) : null}
              {issueBranches.length > 0 ? (
                <CommandGroup heading="Create from issue">
                  {issueBranches.map(({ issue, name }) => (
                    <CommandItem
                      key={issue.identifier}
                      value={`issue:${issue.identifier}`}
                      onSelect={() =>
                        choose(() =>
                          controls.runAction("create-branch", {
                            branchName: name,
                          }),
                        )
                      }
                    >
                      <Plus className="size-3.5" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="min-w-0 max-w-[40%] truncate text-[11px] text-slate-500">
                        {issue.title}
                      </span>
                      <span className="shrink-0 rounded border border-slate-700 px-1 text-[10px] text-slate-400">
                        {issue.identifier}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {groups.recent.length > 0 ? (
                <CommandGroup heading="Recent">
                  {groups.recent.map((branch) => branchItem(branch, "recent"))}
                </CommandGroup>
              ) : null}
              {groups.local.length > 0 ? (
                <CommandGroup heading="Local">
                  {groups.local.map((branch) => branchItem(branch, "local"))}
                </CommandGroup>
              ) : null}
              {groups.remote.length > 0 ? (
                <CommandGroup heading="Remote">
                  {groups.remote.map((branch) => branchItem(branch, "remote"))}
                </CommandGroup>
              ) : null}
              <CommandGroup>
                <CommandItem
                  value="cleanup"
                  onSelect={() => {
                    setOpen(false);
                    setCleanupOpen(true);
                  }}
                >
                  <Brush className="size-3.5" />
                  Clean up branches…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {cleanupOpen ? (
        <WorkspaceGitBranchCleanup
          controls={controls}
          overview={overview}
          candidates={candidates}
          onClose={() => setCleanupOpen(false)}
        />
      ) : null}
    </>
  );
};
