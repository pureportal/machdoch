import { ArrowLeftRight, GitBranchPlus, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceGitBranchSwitchResult,
  WorkspaceGitBranchSwitchTarget,
} from "@machdoch/fleet-protocol/workspace-contract";
import { isValidGitBranchName } from "./branch-name";
import {
  useWorkspaceGitBranchStatus,
  useWorkspaceGitBranchSwitching,
  type WorkspaceGitBranchStatusStore,
} from "./branch-status-store";
import {
  describeSessionGitBranchBlocker,
  evaluateSessionGitBranch,
  sessionGitBranchPrimaryPlan,
  sessionGitBranchSuggestions,
  sessionGitRepositoryName,
  summarizeSessionGitBranchSwitch,
  type SessionGitBranchPlan,
} from "./session-git-branch";
import {
  SESSION_GIT_BRANCH_STATUS,
  SessionGitBranchDetails,
  type SessionGitBranchNotice,
} from "./session-git-branch-details";
import { SessionGitBranchPicker } from "./session-git-branch-picker";

interface ScopedNotice extends SessionGitBranchNotice {
  scope: string;
}

const TASK_RUNNING_REASON = "Wait for the running task to finish.";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const primaryPlanLabel = (
  plan: SessionGitBranchPlan,
  branchName: string,
): string => {
  if (plan.kind === "create") return `Create ${branchName}`;
  const target = plan.targets.every((entry) => entry.branchName === branchName)
    ? `switch to ${branchName}`
    : "switch branches";
  return plan.dirtyRepositories.length > 0
    ? `Stash changes and ${target}`
    : `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
};

export const SessionGitBranchControl = ({
  sessionId,
  workspaceRoot,
  branchName,
  workspaceTaskRunning,
  store,
  switchBranches,
  onBranchChange,
  onSwitched,
}: {
  sessionId: string;
  workspaceRoot: string | null | undefined;
  branchName: string | undefined;
  workspaceTaskRunning: boolean;
  store: WorkspaceGitBranchStatusStore;
  switchBranches: (
    workspaceRoot: string,
    targets: readonly WorkspaceGitBranchSwitchTarget[],
    stashChanges: boolean,
  ) => Promise<WorkspaceGitBranchSwitchResult[]>;
  onBranchChange: (branchName: string | null) => void;
  onSwitched?: (workspaceRoot: string) => void;
}): JSX.Element | null => {
  const root = workspaceRoot?.trim() || null;
  const branch = branchName ?? null;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<ScopedNotice | null>(null);
  const scope = root ? `${sessionId}\n${root}\n${branch ?? ""}` : "";
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const entry = useWorkspaceGitBranchStatus(
    store,
    root,
    branch,
    branch !== null || open,
  );
  const switching = useWorkspaceGitBranchSwitching(store, root);
  const previousTaskRunningRef = useRef(workspaceTaskRunning);
  const status = entry?.status ?? null;

  useEffect(() => {
    setOpen(false);
    setEditing(false);
  }, [sessionId, root]);

  useEffect(() => {
    if (previousTaskRunningRef.current && !workspaceTaskRunning && root) {
      store.invalidate(root);
    }
    previousTaskRunningRef.current = workspaceTaskRunning;
  }, [root, store, workspaceTaskRunning]);

  const evaluation = useMemo(
    () => (branch && status ? evaluateSessionGitBranch(branch, status) : null),
    [branch, status],
  );
  const primaryPlan = useMemo(
    () => (evaluation ? sessionGitBranchPrimaryPlan(evaluation) : null),
    [evaluation],
  );
  const suggestions = useMemo(
    () => (status ? sessionGitBranchSuggestions(status) : []),
    [status],
  );

  if (!root) return null;

  const repositoryName = (relativePath: string): string =>
    sessionGitRepositoryName(status?.workspaceRoot ?? root, relativePath);
  const blocker = primaryPlan?.blockers[0];
  const blockedReason = workspaceTaskRunning
    ? TASK_RUNNING_REASON
    : blocker
      ? describeSessionGitBranchBlocker(
          blocker,
          repositoryName(blocker.relativePath),
        )
      : null;
  const actionsDisabled = switching || workspaceTaskRunning;

  const runPlan = async (
    plan: SessionGitBranchPlan,
    stashChanges: boolean,
  ): Promise<void> => {
    if (
      plan.targets.length === 0 ||
      plan.blockers.length > 0 ||
      workspaceTaskRunning ||
      store.isSwitching(root)
    ) {
      return;
    }
    const runScope = scope;
    let outcome: SessionGitBranchNotice | null = null;
    store.setSwitching(root, true);
    setNotice(null);
    try {
      const results = await switchBranches(root, plan.targets, stashChanges);
      const summary = summarizeSessionGitBranchSwitch(results, repositoryName);
      if (summary.failures.length > 0) {
        outcome = { tone: "error", text: summary.failures.join("\n") };
      } else if (summary.stashed.length > 0) {
        outcome = {
          tone: "info",
          text: `Stashed changes in ${summary.stashed.join(", ")}.`,
        };
      }
    } catch (error) {
      outcome = { tone: "error", text: errorMessage(error) };
    } finally {
      store.setSwitching(root, false);
      store.invalidate(root);
      onSwitched?.(root);
    }
    if (outcome && scopeRef.current === runScope) {
      setNotice({ ...outcome, scope: runScope });
      setOpen(true);
    }
  };

  const commitBranch = (nextBranch: string): void => {
    const trimmed = nextBranch.trim();
    if (!isValidGitBranchName(trimmed)) return;
    setEditing(false);
    setNotice(null);
    if (trimmed === branch) return;
    onBranchChange(trimmed);
    store.request(root, trimmed, { force: true });
    store.request(root, trimmed, { fetch: true });
  };

  const removeBranch = (): void => {
    setEditing(false);
    setNotice(null);
    setOpen(false);
    onBranchChange(null);
  };

  const notices: SessionGitBranchNotice[] = [];
  if (notice?.scope === scope) notices.push(notice);
  if (entry?.error) notices.push({ tone: "error", text: entry.error });
  if (primaryPlan && workspaceTaskRunning) {
    notices.push({ tone: "info", text: TASK_RUNNING_REASON });
  }
  for (const planBlocker of primaryPlan?.blockers ?? []) {
    notices.push({
      tone: "info",
      text: describeSessionGitBranchBlocker(
        planBlocker,
        repositoryName(planBlocker.relativePath),
      ),
    });
  }
  if (status?.issues[0]) notices.push({ tone: "info", text: status.issues[0] });

  const presentation = evaluation
    ? SESSION_GIT_BRANCH_STATUS[evaluation.status]
    : null;
  const StatusIcon = presentation?.icon ?? LoaderCircle;
  const primaryLabel =
    primaryPlan && branch ? primaryPlanLabel(primaryPlan, branch) : null;
  const showPicker = branch === null || editing;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setEditing(false);
      }}
    >
      <div className="flex shrink-0 items-center">
        <PopoverTrigger asChild>
          {branch ? (
            <button
              type="button"
              aria-label={`Session branch ${branch}: ${presentation?.label ?? "Loading"}`}
              className="flex h-7 max-w-28 min-w-0 items-center sm:max-w-44 gap-1.5 rounded-lg px-2 text-[11px] text-slate-300 outline-none hover:bg-slate-900 hover:text-white focus-visible:ring-2 focus-visible:ring-sky-400/50"
            >
              <StatusIcon
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  presentation?.tone ?? "animate-spin text-slate-500",
                )}
              />
              <span className="min-w-0 truncate">{branch}</span>
            </button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Assign branch"
              className="h-7 w-7 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <GitBranchPlus className="h-4 w-4" />
            </Button>
          )}
        </PopoverTrigger>
        {primaryPlan && primaryLabel && !open ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={primaryLabel}
            tooltip={blockedReason ?? primaryLabel}
            disabled={actionsDisabled || blockedReason !== null}
            onClick={() => void runPlan(primaryPlan, true)}
            className="h-7 w-7 rounded-lg text-slate-300 hover:bg-slate-900 hover:text-white"
          >
            {switching ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : primaryPlan.kind === "create" ? (
              <GitBranchPlus className="h-4 w-4" />
            ) : (
              <ArrowLeftRight className="h-4 w-4" />
            )}
          </Button>
        ) : null}
      </div>
      <PopoverContent
        align="end"
        aria-label="Session branch"
        className="w-[min(26rem,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget;
          if (
            content instanceof HTMLElement &&
            !content.contains(document.activeElement)
          ) {
            content.focus({ preventScroll: true });
          }
        }}
      >
        {showPicker ? (
          <SessionGitBranchPicker
            branchName={branch}
            suggestions={suggestions}
            loading={!status && (entry?.loading ?? true)}
            onSelect={commitBranch}
          />
        ) : (
          <SessionGitBranchDetails
            evaluation={evaluation}
            primaryPlan={primaryPlan}
            loading={entry?.loading ?? true}
            fetching={entry?.fetching ?? false}
            switching={switching}
            actionsDisabled={actionsDisabled}
            notices={notices}
            repositoryName={repositoryName}
            onFetch={() =>
              store.request(root, branch, {
                fetch: true,
              })
            }
            onEdit={() => setEditing(true)}
            onRemove={removeBranch}
            onRun={(plan, stashChanges) => void runPlan(plan, stashChanges)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
};
