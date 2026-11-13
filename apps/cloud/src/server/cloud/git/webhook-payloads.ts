import type { GitEvent, GitEventKind } from "../../../lib/git-events";
import type { GitPullRequestRecord } from "./git-client";

export interface WebhookActivity extends Partial<
  Pick<GitEvent, "branch" | "push" | "review" | "comment" | "tag">
> {
  kind: GitEventKind;
  pullRequestNumber: number | null;
}

export interface ParsedWebhook {
  repositoryExternalId: number;
  sender: string | null;
  pullRequest: GitPullRequestRecord | null;
  fetchPullRequest: number | null;
  staleSha: string | null;
  staleNumber: number | null;
  activities: WebhookActivity[];
}

export const zeroSha = "0".repeat(40);

export function parsedWebhook(
  repositoryExternalId: number,
  fields: Partial<ParsedWebhook>,
): ParsedWebhook {
  return {
    repositoryExternalId,
    sender: null,
    pullRequest: null,
    fetchPullRequest: null,
    staleSha: null,
    staleNumber: null,
    activities: [],
    ...fields,
  };
}

export function referenceName(
  ref: string,
): { kind: "branch" | "tag"; name: string } | null {
  if (ref.startsWith("refs/heads/"))
    return { kind: "branch", name: ref.slice("refs/heads/".length) };
  if (ref.startsWith("refs/tags/"))
    return { kind: "tag", name: ref.slice("refs/tags/".length) };
  return null;
}

export function pushActivities(input: {
  ref: string;
  before: string;
  after: string;
  forced: boolean;
  compareUrl: string | null;
  commits: { id: string; message: string; author: string }[];
}): WebhookActivity[] {
  const reference = referenceName(input.ref);
  if (!reference) return [];
  const created = input.before === zeroSha;
  const deleted = input.after === zeroSha;
  if (reference.kind === "tag")
    return created
      ? [{ kind: "tag_created", pullRequestNumber: null, tag: reference.name }]
      : [];
  const push = {
    before: input.before,
    after: input.after,
    forced: input.forced,
    compareUrl: input.compareUrl,
    commits: input.commits.slice(0, 50).map((commit) => ({
      id: commit.id,
      message: commit.message.slice(0, 2_000),
      author: commit.author.slice(0, 100),
    })),
  };
  const branch = reference.name;
  if (deleted)
    return [{ kind: "branch_deleted", pullRequestNumber: null, branch }];
  return [
    ...(created
      ? [{ kind: "branch_created" as const, pullRequestNumber: null, branch }]
      : []),
    ...(!created || push.commits.length
      ? [{ kind: "push" as const, pullRequestNumber: null, branch, push }]
      : []),
  ];
}
