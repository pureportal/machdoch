import type {
  CloudPullRequest,
  GitHubCheckRun,
  GitHubReviewComment,
} from "./cloud-github-contract";
import { issueSessionTitle } from "./issue-text";

export interface PromptIssue {
  identifier: string;
  title: string;
  url: string;
}

type PromptPullRequest = Pick<
  CloudPullRequest,
  "repository" | "number" | "title" | "url" | "headRef" | "baseRef"
>;

export type PullRequestTask = "conflicts" | "checks" | "review";

const taskTitles: Record<PullRequestTask, string> = {
  conflicts: "Resolve conflicts in",
  checks: "Fix checks on",
  review: "Address review on",
};

function reference(pullRequest: PromptPullRequest): string {
  return `${pullRequest.repository}#${pullRequest.number}`;
}

function heading(task: string, pullRequest: PromptPullRequest): string {
  return `${task} ${reference(pullRequest)}: ${pullRequest.title}\n${pullRequest.url}`;
}

function issueLines(issues: readonly PromptIssue[]): string[] {
  return issues.map(
    (issue) => `${issue.identifier}: ${issue.title}\n${issue.url}`,
  );
}

function finish(pullRequest: PromptPullRequest): string {
  return `Run the project checks, then commit and push ${pullRequest.headRef}.`;
}

export function pullRequestSessionTitle(
  task: PullRequestTask,
  pullRequest: PromptPullRequest,
  issues: readonly PromptIssue[],
): string {
  return issueSessionTitle(
    issues[0]?.identifier ?? "",
    `${taskTitles[task]} ${reference(pullRequest)}`,
  );
}

export function pullRequestConflictPrompt(
  pullRequest: PromptPullRequest,
  issues: readonly PromptIssue[],
): string {
  const { headRef, baseRef } = pullRequest;
  return [
    heading("Resolve the merge conflicts in", pullRequest),
    `Check out ${headRef}, merge origin/${baseRef} into it and resolve every conflict so both sides keep their intent. ${finish(pullRequest)}`,
    ...issueLines(issues),
  ].join("\n\n");
}

export function pullRequestChecksPrompt(
  pullRequest: PromptPullRequest,
  failed: readonly GitHubCheckRun[],
  issues: readonly PromptIssue[],
): string {
  return [
    heading("Fix the failing checks on", pullRequest),
    failed
      .map((run) => (run.url ? `${run.name}: ${run.url}` : run.name))
      .join("\n"),
    `Check out ${pullRequest.headRef}, reproduce each failure locally and fix its cause. ${finish(pullRequest)}`,
    ...issueLines(issues),
  ].join("\n\n");
}

export function pullRequestReviewPrompt(
  pullRequest: PromptPullRequest,
  comments: readonly GitHubReviewComment[],
  issues: readonly PromptIssue[],
): string {
  return [
    heading("Address the review comments on", pullRequest),
    ...comments.map((comment) =>
      [
        `${comment.path}${comment.line === null ? "" : `:${comment.line}`} (${comment.author})`,
        comment.body.trim(),
        comment.url,
      ].join("\n"),
    ),
    `Make the requested changes on ${pullRequest.headRef}. ${finish(pullRequest)}`,
    ...issueLines(issues),
  ].join("\n\n");
}
