import type { CloudPullRequest } from "./cloud-git-contract";
import type { GitProvider } from "./git-providers";

export const reviewGroups = [
  "requested",
  "attention",
  "ready",
  "waiting",
  "draft",
  "done",
] as const;
export type ReviewGroup = (typeof reviewGroups)[number];

export const reviewGroupLabels: Record<ReviewGroup, string> = {
  requested: "Needs your review",
  attention: "Needs your attention",
  ready: "Ready to merge",
  waiting: "Waiting for review",
  draft: "Drafts",
  done: "Recently closed",
};

export type ReviewerState = "approved" | "changes_requested" | "pending";
export type ReviewerKind = "human" | "copilot" | "agent";

export interface PullRequestReviewer {
  login: string;
  state: ReviewerState;
  kind: ReviewerKind;
}

const copilotLogins = new Set([
  "copilot",
  "copilot-pull-request-reviewer",
  "copilot-pull-request-reviewer[bot]",
  "copilot-swe-agent",
  "copilot-swe-agent[bot]",
]);

export function pullRequestReviewers(
  requested: string[],
  reviews: { author: string; state: string }[],
  agentLogin: string,
): PullRequestReviewer[] {
  const agent = agentLogin.toLowerCase();
  const reviewers = new Map<string, PullRequestReviewer>();
  const add = (login: string, state: ReviewerState) => {
    const key = login.toLowerCase();
    if (copilotLogins.has(key))
      reviewers.set("copilot", { login: "Copilot", state, kind: "copilot" });
    else
      reviewers.set(key, {
        login,
        state,
        kind: key === agent ? "agent" : "human",
      });
  };
  for (const review of reviews) {
    const state =
      review.state === "APPROVED"
        ? "approved"
        : review.state === "CHANGES_REQUESTED"
          ? "changes_requested"
          : null;
    if (state) add(review.author, state);
  }
  for (const login of requested) add(login, "pending");
  return [...reviewers.values()];
}

export function reviewGroup(
  pullRequest: Pick<
    CloudPullRequest,
    "provider" | "author" | "requestedReviewers" | "state" | "stage"
  >,
  accounts: { provider: GitProvider; login: string }[],
): ReviewGroup | null {
  const logins = new Set(
    accounts
      .filter((account) => account.provider === pullRequest.provider)
      .map((account) => account.login.toLowerCase()),
  );
  const authored =
    !!pullRequest.author && logins.has(pullRequest.author.toLowerCase());
  const requested = pullRequest.requestedReviewers.some((login) =>
    logins.has(login.toLowerCase()),
  );
  if (!authored)
    return requested && pullRequest.state === "open" ? "requested" : null;
  if (pullRequest.state !== "open") return "done";
  if (pullRequest.stage === "draft") return "draft";
  if (pullRequest.stage === "attention") return "attention";
  if (pullRequest.stage === "ready") return "ready";
  return "waiting";
}
