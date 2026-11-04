import {
  ArrowLeftRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  GitBranchPlus,
  LoaderCircle,
  Pencil,
  RefreshCw,
  TriangleAlert,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  planSessionGitBranchCreate,
  planSessionGitBranchSwitch,
  type SessionGitBranchEvaluation,
  type SessionGitBranchPlan,
  type SessionGitBranchRepositoryEvaluation,
  type SessionGitBranchRepositoryState,
  type SessionGitBranchStatus,
} from "../_helpers/session-git-branch";

interface Presentation {
  label: string;
  icon: LucideIcon;
  tone: string;
}

export const SESSION_GIT_BRANCH_TONE = {
  success: "text-emerald-700 dark:text-emerald-300",
  info: "text-sky-700 dark:text-sky-300",
  warning: "text-amber-700 dark:text-amber-300",
  danger: "text-rose-500 dark:text-rose-300",
  muted: "text-(--app-text-muted)",
  faint: "text-(--app-text-faint)",
} as const;

export const SESSION_GIT_BRANCH_STATUS: Record<
  SessionGitBranchStatus,
  Presentation
> = {
  matched: {
    label: "Checked out",
    icon: CircleCheck,
    tone: SESSION_GIT_BRANCH_TONE.success,
  },
  new: {
    label: "Not created yet",
    icon: CircleDot,
    tone: SESSION_GIT_BRANCH_TONE.info,
  },
  "not-switched": {
    label: "Not checked out",
    icon: CircleAlert,
    tone: SESSION_GIT_BRANCH_TONE.warning,
  },
  mismatch: {
    label: "Different branch checked out",
    icon: TriangleAlert,
    tone: SESSION_GIT_BRANCH_TONE.danger,
  },
  unknown: {
    label: "Git status unavailable",
    icon: CircleAlert,
    tone: SESSION_GIT_BRANCH_TONE.muted,
  },
};

const REPOSITORY_STATE: Record<SessionGitBranchRepositoryState, Presentation> =
  {
    "on-branch": {
      label: "On branch",
      icon: CircleCheck,
      tone: SESSION_GIT_BRANCH_TONE.success,
    },
    "on-default": {
      label: "On default branch",
      icon: CircleDot,
      tone: SESSION_GIT_BRANCH_TONE.muted,
    },
    "not-switched": {
      label: "Branch not checked out",
      icon: CircleAlert,
      tone: SESSION_GIT_BRANCH_TONE.warning,
    },
    "other-branch": {
      label: "Different branch",
      icon: TriangleAlert,
      tone: SESSION_GIT_BRANCH_TONE.danger,
    },
    detached: {
      label: "Detached HEAD",
      icon: TriangleAlert,
      tone: SESSION_GIT_BRANCH_TONE.danger,
    },
    unavailable: {
      label: "Unavailable",
      icon: CircleAlert,
      tone: SESSION_GIT_BRANCH_TONE.faint,
    },
  };

export interface SessionGitBranchNotice {
  tone: "error" | "info";
  text: string;
}

const RepositoryRow = ({
  entry,
  name,
  evaluation,
  showActions,
  actionsDisabled,
  onRun,
}: {
  entry: SessionGitBranchRepositoryEvaluation;
  name: string;
  evaluation: SessionGitBranchEvaluation;
  showActions: boolean;
  actionsDisabled: boolean;
  onRun: (plan: SessionGitBranchPlan, stashChanges: boolean) => void;
}): JSX.Element => {
  const { repository, state, expectedBranch } = entry;
  const presentation = REPOSITORY_STATE[state];
  const Icon = presentation.icon;
  const current = repository.currentBranch ?? "Detached HEAD";
  const switchPlan = planSessionGitBranchSwitch(
    evaluation,
    repository.repositoryRoot,
  );
  const createPlan = planSessionGitBranchCreate(
    evaluation,
    repository.repositoryRoot,
  );
  const canSwitch =
    showActions &&
    switchPlan.targets.length > 0 &&
    switchPlan.blockers.length === 0;
  const canCreate =
    showActions &&
    createPlan.targets.length > 0 &&
    createPlan.blockers.length === 0;
  const dirty = switchPlan.dirtyRepositories.length > 0;

  return (
    <li className="col-span-full grid min-h-8 grid-cols-subgrid items-center px-3 py-1 text-xs">
      <Icon
        role="img"
        aria-label={presentation.label}
        className={cn("size-3.5 shrink-0", presentation.tone)}
      />
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
      <span
        className="min-w-0 truncate font-mono text-[11px] text-(--app-text-muted)"
        title={repository.error ?? current}
      >
        {repository.error ? (
          repository.error
        ) : (
          <>
            {current}
            {expectedBranch && expectedBranch !== repository.currentBranch ? (
              <>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> should be </span>
                <span className="text-(--app-text)">{expectedBranch}</span>
              </>
            ) : null}
          </>
        )}
      </span>
      <div className="flex items-center justify-end gap-1">
        {repository.changes > 0 ? (
          <span
            aria-label={`${repository.changes} changed`}
            className={cn(
              "shrink-0 rounded-full px-1.5 leading-4",
              repository.conflicts > 0
                ? "bg-red-500/15 text-rose-500 dark:text-red-300"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-200",
            )}
          >
            {repository.changes}
          </span>
        ) : null}
        {canSwitch && expectedBranch ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={
              dirty
                ? `Stash changes and switch ${name} to ${expectedBranch}`
                : `Switch ${name} to ${expectedBranch}`
            }
            disabled={actionsDisabled}
            onClick={() => onRun(switchPlan, true)}
          >
            <ArrowLeftRight />
          </Button>
        ) : null}
        {canCreate ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Create ${evaluation.branchName} in ${name}`}
            disabled={actionsDisabled}
            onClick={() => onRun(createPlan, false)}
          >
            <GitBranchPlus />
          </Button>
        ) : null}
      </div>
    </li>
  );
};

export const SessionGitBranchDetails = ({
  evaluation,
  primaryPlan,
  loading,
  fetching,
  switching,
  actionsDisabled,
  notices,
  repositoryName,
  onFetch,
  onEdit,
  onRemove,
  onRun,
}: {
  evaluation: SessionGitBranchEvaluation | null;
  primaryPlan: SessionGitBranchPlan | null;
  loading: boolean;
  fetching: boolean;
  switching: boolean;
  actionsDisabled: boolean;
  notices: readonly SessionGitBranchNotice[];
  repositoryName: (relativePath: string) => string;
  onFetch: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onRun: (plan: SessionGitBranchPlan, stashChanges: boolean) => void;
}): JSX.Element => {
  const status = evaluation
    ? SESSION_GIT_BRANCH_STATUS[evaluation.status]
    : null;
  const StatusIcon = status?.icon ?? LoaderCircle;
  const runnable =
    primaryPlan !== null &&
    primaryPlan.targets.length > 0 &&
    primaryPlan.blockers.length === 0;
  const dirty =
    primaryPlan?.kind === "switch" && primaryPlan.dirtyRepositories.length > 0;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-(--app-border) px-3 py-2">
        <StatusIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            status?.tone ?? `animate-spin ${SESSION_GIT_BRANCH_TONE.faint}`,
          )}
        />
        <span
          role="status"
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-medium",
            status?.tone ?? SESSION_GIT_BRANCH_TONE.muted,
          )}
        >
          {status?.label ?? ""}
        </span>
        {loading && status ? (
          <LoaderCircle
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 animate-spin",
              SESSION_GIT_BRANCH_TONE.faint,
            )}
          />
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Fetch"
          disabled={fetching || switching}
          onClick={onFetch}
        >
          <RefreshCw className={cn(fetching && "animate-spin")} />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Change branch"
          onClick={onEdit}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Remove branch"
          onClick={onRemove}
        >
          <Unlink />
        </Button>
      </div>
      {evaluation && evaluation.repositories.length > 0 ? (
        <ul
          aria-label="Repositories"
          className="grid max-h-64 grid-cols-[auto_fit-content(45%)_minmax(0,1fr)_auto] gap-x-2 overflow-y-auto py-1"
        >
          {evaluation.repositories.map((entry) => (
            <RepositoryRow
              key={entry.repository.repositoryRoot}
              entry={entry}
              name={repositoryName(entry.repository.relativePath)}
              evaluation={evaluation}
              showActions={evaluation.repositories.length > 1}
              actionsDisabled={actionsDisabled}
              onRun={onRun}
            />
          ))}
        </ul>
      ) : null}
      {notices.map((notice) => (
        <p
          key={notice.text}
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "border-t border-(--app-border) px-3 py-2 text-xs whitespace-pre-line",
            notice.tone === "error"
              ? SESSION_GIT_BRANCH_TONE.danger
              : SESSION_GIT_BRANCH_TONE.muted,
          )}
        >
          {notice.text}
        </p>
      ))}
      {primaryPlan && primaryPlan.targets.length > 0 ? (
        <div className="flex justify-end gap-2 border-t border-(--app-border) px-3 py-2">
          {dirty ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!runnable || actionsDisabled}
              onClick={() => onRun(primaryPlan, false)}
            >
              Switch with changes
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            disabled={!runnable || actionsDisabled}
            onClick={() => onRun(primaryPlan, true)}
          >
            {switching ? <LoaderCircle className="animate-spin" /> : null}
            {primaryPlan.kind === "create"
              ? "Create branch"
              : dirty
                ? "Stash & switch"
                : "Switch"}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
