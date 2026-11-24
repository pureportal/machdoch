"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Layers,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { CloudPullRequest } from "@/lib/cloud-git-contract";
import type { GitChecksState } from "@/lib/git-automation";
import { gitProviderLabels } from "@/lib/git-providers";
import type { PullRequestHeaderSummary } from "@/lib/pull-request-header";
import type {
  PullRequestReviewer,
  ReviewerState,
} from "@/lib/pull-request-reviews";
import { StateIcon } from "./issue-properties";
import { PersonAvatar } from "./person-avatar";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
  pullRequestStateLabel,
} from "./pull-request-state";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

const reviewerLabels: Record<ReviewerState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  pending: "Review requested",
};

const checkIcons: Record<GitChecksState, LucideIcon> = {
  success: CircleCheck,
  failure: CircleX,
  pending: CircleDashed,
  none: CircleMinus,
};

function ReviewerIcon({ state }: { state: ReviewerState }) {
  const label = reviewerLabels[state];
  if (state === "approved")
    return (
      <CircleCheck
        size={13}
        role="img"
        aria-label={label}
        data-tone="success"
      />
    );
  if (state === "changes_requested")
    return (
      <CircleX size={13} role="img" aria-label={label} data-tone="danger" />
    );
  return <CircleDashed size={13} role="img" aria-label={label} />;
}

function ReviewerAvatar({ reviewer }: { reviewer: PullRequestReviewer }) {
  if (reviewer.kind === "human")
    return <PersonAvatar name={reviewer.login} className="cloud-avatar-tiny" />;
  const Icon = reviewer.kind === "copilot" ? Sparkles : Bot;
  return (
    <span className="cloud-reviewer-bot" data-kind={reviewer.kind}>
      <Icon
        size={11}
        role="img"
        aria-label={reviewer.kind === "copilot" ? "Copilot" : "machdoch agent"}
      />
    </span>
  );
}

function Signals({ summary }: { summary: PullRequestHeaderSummary }) {
  const CheckIcon = checkIcons[summary.checks.state];
  return (
    <div className="cloud-pull-request-meta cloud-pull-request-header-signals">
      {summary.reviewers.length > 0 && (
        <ul className="cloud-pull-request-reviewers" aria-label="Reviewers">
          {summary.reviewers.map((reviewer) => (
            <li key={reviewer.login} data-kind={reviewer.kind}>
              <ReviewerAvatar reviewer={reviewer} />
              <span>{reviewer.login}</span>
              <ReviewerIcon state={reviewer.state} />
            </li>
          ))}
        </ul>
      )}
      <span
        className="cloud-pull-request-checks-summary"
        data-state={summary.checks.state}
      >
        <CheckIcon size={13} aria-hidden="true" />
        {summary.checks.label}
      </span>
      {summary.resolves.length > 0 && (
        <span className="cloud-pull-request-resolves">
          Resolves
          {summary.resolves.map((issue) => (
            <Link
              key={issue.id}
              href={`/cloud/issues/${issue.id}`}
              prefetch={false}
              title={issue.title}
            >
              <StateIcon state={issue.state} />
              {issue.identifier}
            </Link>
          ))}
        </span>
      )}
      {summary.stack && (
        <span className="cloud-pull-request-stack-position">
          <Layers size={13} aria-hidden="true" />
          Stack {summary.stack.position} of {summary.stack.size}
        </span>
      )}
    </div>
  );
}

export function PullRequestHeader({
  pullRequest,
  summary,
}: {
  pullRequest: CloudPullRequest;
  summary: PullRequestHeaderSummary | null;
}) {
  const toast = useToast();
  const checkout = `git fetch origin ${pullRequest.headRef} && git switch ${pullRequest.headRef}`;
  return (
    <header className="cloud-page-header cloud-pull-request-page-header">
      <div>
        <Link className="cloud-back-link" href="/cloud/pull-requests">
          <ArrowLeft size={14} aria-hidden="true" /> Pull requests
        </Link>
        <h1>
          {pullRequest.title}{" "}
          <span className="cloud-pull-request-number">
            #{pullRequest.number}
          </span>
        </h1>
        <div className="cloud-pull-request-meta">
          <span
            className="cloud-pull-request-state"
            data-state={pullRequest.draft ? "draft" : pullRequest.state}
          >
            <PullRequestStageIcon stage={pullRequest.stage} label="" />
            {pullRequestStateLabel(pullRequest)}
          </span>
          {pullRequest.state === "open" && !pullRequest.draft && (
            <span
              className="cloud-pull-request-stage"
              data-stage={pullRequest.stage}
            >
              {pullRequestStageLabels[pullRequest.stage]}
            </span>
          )}
          {pullRequest.author && <strong>{pullRequest.author}</strong>}
          <span className="cloud-pull-request-branch">
            <code>{pullRequest.headRef}</code>→
            <code>{pullRequest.baseRef}</code>
            {pullRequest.state === "open" && (
              <button
                type="button"
                className="cloud-pull-request-copy"
                aria-label="Copy checkout command"
                title={checkout}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(checkout)
                    .then(() => toast("Checkout command copied"))
                    .catch(() => toast("Copy failed", "error"))
                }
              >
                <Terminal size={13} aria-hidden="true" />
              </button>
            )}
          </span>
          <span>{pullRequest.repository}</span>
          <RelativeTime value={pullRequest.updatedAt} />
        </div>
        {summary && <Signals summary={summary} />}
      </div>
      <a
        className="cloud-pull-request-external"
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
      >
        {gitProviderLabels[pullRequest.provider]}
        <ArrowUpRight size={13} aria-hidden="true" />
      </a>
    </header>
  );
}
