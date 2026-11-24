import type { GitEvent, GitEventKind } from "../../../lib/git-events";
import type {
  GitIssueFields,
  GitIssueUpdate,
  GitPullRequestRecord,
} from "./git-client";

export interface WebhookActivity extends Partial<
  Pick<GitEvent, "branch" | "push" | "review" | "comment" | "tag">
> {
  kind: GitEventKind;
  pullRequestNumber: number | null;
}

export interface DeploymentEvent {
  source: "deployment" | "workflow_run" | "tag";
  environment: string | null;
  version: string;
  sha: string;
  externalId: string;
  url: string | null;
}

export interface IssueWebhook {
  number: number;
  current: (GitIssueFields & { url: string }) | null;
  changes: GitIssueUpdate;
  comment: { externalId: string; body: string; author: string } | null;
  removed: boolean;
}

export interface ParsedWebhook {
  repositoryExternalId: number;
  sender: string | null;
  pullRequest: GitPullRequestRecord | null;
  fetchPullRequest: number | null;
  staleSha: string | null;
  staleNumber: number | null;
  activities: WebhookActivity[];
  deployment: DeploymentEvent | null;
  issue: IssueWebhook | null;
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
    deployment: null,
    issue: null,
    ...fields,
  };
}

export function issueLabelNames(names: string[]): string[] {
  const labels = new Map<string, string>();
  for (const label of names) {
    const name = label.trim();
    if (name && name.length <= 80 && !labels.has(name.toLowerCase()))
      labels.set(name.toLowerCase(), name);
  }
  return [...labels.values()];
}

export function issueFields(input: {
  title: string;
  body: string | null | undefined;
  state: GitIssueFields["state"];
  labels: string[];
  assignee: string | null | undefined;
  url: string;
}): (GitIssueFields & { url: string }) | null {
  const title = input.title.trim().slice(0, 300);
  if (!title) return null;
  return {
    title,
    body: (input.body ?? "").slice(0, 30_000),
    state: input.state,
    labels: issueLabelNames(input.labels),
    assignee: input.assignee?.slice(0, 100) || null,
    url: input.url.slice(0, 500),
  };
}

export function tagDeployment(
  ref: string,
  after: string,
  created: boolean,
): DeploymentEvent | null {
  const reference = referenceName(ref);
  if (reference?.kind !== "tag" || !created || after === zeroSha) return null;
  return {
    source: "tag",
    environment: null,
    version: reference.name.slice(0, 40),
    sha: after,
    externalId: `tag:${reference.name}`,
    url: null,
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
