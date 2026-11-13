import { z } from "zod";
import type { GitChecksState, PullRequestState } from "./git-automation";
import type { GitProvider } from "./git-providers";

export const gitEventKinds = [
  "push",
  "branch_created",
  "branch_deleted",
  "tag_created",
  "pull_request_opened",
  "pull_request_updated",
  "pull_request_ready",
  "pull_request_draft",
  "pull_request_merged",
  "pull_request_closed",
  "pull_request_reopened",
  "review_approved",
  "review_changes_requested",
  "review_commented",
  "review_dismissed",
  "comment_created",
  "checks_passed",
  "checks_failed",
  "stack_base_merged",
] as const;
export type GitEventKind = (typeof gitEventKinds)[number];

const repositoryEventKinds = new Set<GitEventKind>([
  "push",
  "branch_created",
  "branch_deleted",
  "tag_created",
]);

export function isPullRequestEvent(kind: GitEventKind): boolean {
  return !repositoryEventKinds.has(kind);
}

export const defaultBranchToken = "$default";
export const automationMarker = "<!-- machdoch-automation -->";

export const branchPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^!?\S+$/u, "Use branch names or patterns without spaces.");

export interface GitEventPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  draft: boolean;
}

export interface GitEventCommit {
  id: string;
  message: string;
  author: string;
}

export interface GitEvent {
  kind: GitEventKind;
  provider: GitProvider;
  repositoryId: string;
  repository: string;
  repositoryUrl: string | null;
  defaultBranch: string;
  branch: string | null;
  sender: string | null;
  pullRequest: GitEventPullRequest | null;
  push: {
    before: string;
    after: string;
    forced: boolean;
    compareUrl: string | null;
    commits: GitEventCommit[];
  } | null;
  review: { state: string; body: string; author: string } | null;
  comment: {
    body: string;
    author: string;
    url: string | null;
    path: string | null;
  } | null;
  tag: string | null;
  parent: {
    number: number;
    title: string;
    headRef: string;
    baseRef: string;
  } | null;
  issueIds: string[];
}

export interface GitEventFilter {
  events: readonly GitEventKind[];
  repositoryIds: readonly string[];
  branches: readonly string[];
  headBranches: readonly string[];
  actors: readonly string[];
  contains: string;
}

function globExpression(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

export function branchMatches(
  patterns: readonly string[],
  branch: string | null,
  defaultBranch: string,
): boolean {
  if (!patterns.length) return true;
  if (branch === null) return false;
  const matches = (pattern: string) =>
    pattern === defaultBranchToken
      ? branch === defaultBranch
      : globExpression(pattern).test(branch);
  const included = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excluded = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    (!included.length || included.some(matches)) && !excluded.some(matches)
  );
}

export function gitEventText(event: GitEvent): string {
  if (event.comment) return event.comment.body;
  if (event.review) return event.review.body;
  if (event.push)
    return event.push.commits.map((commit) => commit.message).join("\n");
  return event.pullRequest?.title ?? event.tag ?? "";
}

export function gitEventMatches(
  filter: GitEventFilter,
  event: GitEvent,
): boolean {
  if (!filter.events.includes(event.kind)) return false;
  if (
    filter.repositoryIds.length &&
    !filter.repositoryIds.includes(event.repositoryId)
  )
    return false;
  if (!branchMatches(filter.branches, event.branch, event.defaultBranch))
    return false;
  if (
    filter.headBranches.length &&
    !branchMatches(
      filter.headBranches,
      event.pullRequest?.headRef ?? null,
      event.defaultBranch,
    )
  )
    return false;
  if (
    filter.actors.length &&
    !filter.actors.some(
      (actor) => actor.toLowerCase() === event.sender?.toLowerCase(),
    )
  )
    return false;
  return (
    !filter.contains ||
    gitEventText(event).toLowerCase().includes(filter.contains.toLowerCase())
  );
}

export function isAutomationText(text: string): boolean {
  return text.includes(automationMarker);
}

export function gitEventVariables(event: GitEvent): Record<string, unknown> {
  return {
    event: { kind: event.kind },
    repository: { name: event.repository, url: event.repositoryUrl ?? "" },
    branch: event.branch ?? "",
    sender: event.sender ?? "",
    tag: event.tag ?? "",
    pullRequest: event.pullRequest && {
      ...event.pullRequest,
      author: event.pullRequest.author ?? "",
    },
    push: event.push && {
      before: event.push.before,
      after: event.push.after,
      forced: event.push.forced,
      compareUrl: event.push.compareUrl ?? "",
      commits: event.push.commits
        .map(
          (commit) =>
            `- ${commit.id.slice(0, 7)} ${commit.message.split("\n", 1)[0]} (${commit.author})`,
        )
        .join("\n"),
    },
    review: event.review,
    comment: event.comment && {
      ...event.comment,
      url: event.comment.url ?? "",
      path: event.comment.path ?? "",
    },
    parent: event.parent,
  };
}

export interface PullRequestSnapshot {
  state: PullRequestState;
  draft: boolean;
  headSha: string;
  checks: GitChecksState | null;
}

export function pullRequestLifecycleEvents(
  previous: PullRequestSnapshot | null,
  next: PullRequestSnapshot,
): GitEventKind[] {
  if (!previous)
    return next.state === "open"
      ? ["pull_request_opened"]
      : next.state === "merged"
        ? ["pull_request_merged"]
        : [];
  const events: GitEventKind[] = [];
  if (previous.state !== next.state)
    events.push(
      next.state === "merged"
        ? "pull_request_merged"
        : next.state === "closed"
          ? "pull_request_closed"
          : "pull_request_reopened",
    );
  if (next.state !== "open") return events;
  if (previous.state === "open") {
    if (previous.draft && !next.draft) events.push("pull_request_ready");
    if (!previous.draft && next.draft) events.push("pull_request_draft");
    if (previous.headSha !== next.headSha) events.push("pull_request_updated");
  }
  if (next.checks !== previous.checks || previous.headSha !== next.headSha) {
    if (next.checks === "success") events.push("checks_passed");
    if (next.checks === "failure") events.push("checks_failed");
  }
  return events;
}
