import {
  Bot,
  CircleCheck,
  CircleDashed,
  CircleX,
  Cloud,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
} from "lucide-react";
import { useState, type JSX } from "react";
import type {
  WorkspacePullRequestCheckState,
  WorkspacePullRequestChecks,
} from "@machdoch/fleet-protocol/workspace-contract";
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  openExternalUrl,
  type WorkspaceGitOverview,
  type WorkspacePullRequest,
} from "../runtime";
import {
  askWorkspaceAgent,
  failedChecksPrompt,
} from "./workspace-agent-requests";
import { cloudPullRequestUrl } from "./workspace-pull-request-links";
import { formatWorkspaceGitTime } from "./workspace-git-time";
import { loadWorkspacePullRequestChecks } from "./workspace-tools-runtime";

const CHECK_ICONS: Record<
  WorkspacePullRequestCheckState,
  { icon: typeof CircleCheck; tone: string }
> = {
  success: { icon: CircleCheck, tone: "text-emerald-300" },
  failure: { icon: CircleX, tone: "text-red-300" },
  pending: { icon: CircleDashed, tone: "text-amber-300" },
  neutral: { icon: CircleDashed, tone: "text-slate-500" },
};

const REVIEW_LABELS: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

const CheckIcon = ({
  state,
}: {
  state: WorkspacePullRequestCheckState;
}): JSX.Element => {
  const { icon: Icon, tone } = CHECK_ICONS[state];
  return (
    <Icon
      aria-label={`Checks ${state}`}
      className={cn("size-3.5 shrink-0", tone)}
    />
  );
};

export const WorkspaceGitPullRequestRow = ({
  overview,
  pullRequest,
  cloudOrigin,
}: {
  overview: WorkspaceGitOverview;
  pullRequest: WorkspacePullRequest;
  cloudOrigin: string | null;
}): JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const [checks, setChecks] = useState<WorkspacePullRequestChecks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cloudUrl = cloudOrigin
    ? cloudPullRequestUrl(cloudOrigin, pullRequest.url)
    : null;
  const review = pullRequest.reviewDecision
    ? REVIEW_LABELS[pullRequest.reviewDecision]
    : undefined;
  const failed =
    checks?.checks.filter((check) => check.state === "failure") ?? [];

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    if (!next) return;
    setError(null);
    void loadWorkspacePullRequestChecks(
      overview.workspaceRoot,
      overview.repositoryRoot,
      pullRequest.number,
    )
      .then(setChecks)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      );
  };

  return (
    <li className="rounded-lg border border-slate-800 bg-slate-950/40">
      <div className="flex min-w-0 items-start gap-3 p-3">
        <GitPullRequest
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-4 shrink-0",
            pullRequest.draft ? "text-slate-500" : "text-emerald-300",
          )}
        />
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-sm text-slate-200">
            <span className="text-slate-500">#{pullRequest.number}</span>{" "}
            {pullRequest.title}
          </p>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs text-slate-500">
            {pullRequest.checks ? (
              <CheckIcon state={pullRequest.checks} />
            ) : null}
            <span className="truncate">
              {pullRequest.headBranch} → {pullRequest.baseBranch}
              {pullRequest.updatedAt
                ? ` · ${formatWorkspaceGitTime(pullRequest.updatedAt)}`
                : ""}
            </span>
          </p>
        </button>
        {pullRequest.draft ? <Badge variant="outline">Draft</Badge> : null}
        {review ? <Badge variant="outline">{review}</Badge> : null}
        {pullRequest.headBranch === overview.branch ? (
          <Badge variant="secondary">Current</Badge>
        ) : null}
        {cloudUrl ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Open in machdoch.cloud"
            onClick={() => void openExternalUrl(cloudUrl)}
          >
            <Cloud />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Open on GitHub"
          onClick={() => void openExternalUrl(pullRequest.url)}
        >
          <ExternalLink />
        </Button>
      </div>
      {expanded ? (
        <div className="space-y-1 border-t border-slate-800 px-3 py-2">
          {error ? (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          ) : !checks ? (
            <LoaderCircle
              aria-label="Loading checks"
              className="size-4 animate-spin text-slate-500"
            />
          ) : checks.checks.length === 0 ? (
            <p className="text-xs text-slate-500">No checks</p>
          ) : (
            <ul className="space-y-px">
              {checks.checks.map((check) => (
                <li
                  key={`${check.workflow ?? ""}:${check.name}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <CheckIcon state={check.state} />
                  <span className="min-w-0 flex-1 truncate text-slate-300">
                    {check.workflow ? `${check.workflow} / ` : ""}
                    {check.name}
                  </span>
                  {check.url ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Open ${check.name}`}
                      onClick={() => void openExternalUrl(check.url!)}
                    >
                      <ExternalLink />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {failed.length > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                askWorkspaceAgent({
                  workspaceRoot: overview.workspaceRoot,
                  prompt: failedChecksPrompt(
                    overview.repositoryRoot,
                    pullRequest,
                    failed,
                  ),
                })
              }
            >
              <Bot />
              Ask agent to fix
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
};
