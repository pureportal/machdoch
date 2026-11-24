import type {
  CloudLinkedIssue,
  CloudPullRequestDetails,
  GitCheckRun,
} from "./cloud-git-contract";
import type { GitChecksState } from "./git-automation";
import {
  pullRequestReviewers,
  type PullRequestReviewer,
} from "./pull-request-reviews";

export interface ChecksSummary {
  state: GitChecksState;
  label: string;
}

export interface PullRequestHeaderSummary {
  reviewers: PullRequestReviewer[];
  checks: ChecksSummary;
  resolves: CloudLinkedIssue[];
  stack: { position: number; size: number } | null;
}

export function checksSummary(runs: readonly GitCheckRun[]): ChecksSummary {
  if (!runs.length) return { state: "none", label: "No checks" };
  const failed = runs.filter((run) => run.state === "failure").length;
  if (failed)
    return { state: "failure", label: `${failed} of ${runs.length} failed` };
  const pending = runs.filter((run) => run.state === "pending").length;
  if (pending)
    return { state: "pending", label: `${pending} of ${runs.length} running` };
  return { state: "success", label: `${runs.length} passed` };
}

export function pullRequestHeader(
  details: Pick<
    CloudPullRequestDetails,
    "pullRequest" | "reviews" | "checks" | "issues" | "agentLogin"
  >,
): PullRequestHeaderSummary {
  const { pullRequest } = details;
  const { stack } = pullRequest;
  return {
    reviewers: pullRequestReviewers(
      pullRequest.requestedReviewers,
      details.reviews,
      details.agentLogin,
    ),
    checks: checksSummary(details.checks.runs),
    resolves: details.issues.filter((issue) => issue.closes),
    stack:
      stack && pullRequest.state === "open"
        ? { position: stack.depth + 1, size: stack.size }
        : null,
  };
}
