import type { CloudPullRequest } from "./cloud-git-contract";
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

function reference(pullRequest: PromptPullRequest): string {
  return `${pullRequest.repository}#${pullRequest.number}`;
}

export function pullRequestConflictSessionTitle(
  pullRequest: PromptPullRequest,
  issues: readonly PromptIssue[],
): string {
  return issueSessionTitle(
    issues[0]?.identifier ?? "",
    `Resolve conflicts in ${reference(pullRequest)}`,
  );
}

export function pullRequestConflictPrompt(
  pullRequest: PromptPullRequest,
  issues: readonly PromptIssue[],
): string {
  const { headRef, baseRef } = pullRequest;
  return [
    `Resolve the merge conflicts in ${reference(pullRequest)}: ${pullRequest.title}\n${pullRequest.url}`,
    `Check out ${headRef}, merge origin/${baseRef} into it and resolve every conflict so both sides keep their intent. Run the project checks, then commit and push ${headRef}.`,
    ...issues.map(
      (issue) => `${issue.identifier}: ${issue.title}\n${issue.url}`,
    ),
  ].join("\n\n");
}
