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

export function pullRequestReviewers(
  requested: string[],
  reviews: { author: string; state: string }[],
): { login: string; state: ReviewerState }[] {
  const reviewers = new Map<string, { login: string; state: ReviewerState }>();
  for (const review of reviews) {
    const state =
      review.state === "APPROVED"
        ? "approved"
        : review.state === "CHANGES_REQUESTED"
          ? "changes_requested"
          : null;
    if (state)
      reviewers.set(review.author.toLowerCase(), {
        login: review.author,
        state,
      });
  }
  for (const login of requested)
    reviewers.set(login.toLowerCase(), { login, state: "pending" });
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
