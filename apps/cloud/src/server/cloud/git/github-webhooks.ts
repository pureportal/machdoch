import { z } from "zod";
import type { GitIssueFields, GitIssueUpdate } from "./git-client";
import { githubPullRequest, githubPullRequestSchema } from "./github-client";
import {
  issueFields,
  issueLabelNames,
  parsedWebhook,
  pushActivities,
  tagDeployment,
  zeroSha,
  type ParsedWebhook,
  type WebhookActivity,
} from "./webhook-payloads";

const repository = z.object({ id: z.number() });
const user = z.object({ login: z.string() }).nullable().optional();

const pushSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  created: z.boolean().optional(),
  deleted: z.boolean().optional(),
  forced: z.boolean().optional(),
  compare: z.string().nullable().optional(),
  commits: z
    .array(
      z.object({
        id: z.string(),
        message: z.string(),
        author: z.object({
          name: z.string().optional(),
          username: z.string().optional(),
        }),
      }),
    )
    .default([]),
  repository,
  sender: user,
});

const pullRequestSchema = z.object({
  action: z.string(),
  pull_request: githubPullRequestSchema,
  repository,
  sender: user,
});

const reviewSchema = pullRequestSchema.extend({
  review: z.object({
    state: z.string(),
    body: z.string().nullable().optional(),
    user,
  }),
});

const reviewCommentSchema = pullRequestSchema.extend({
  comment: z.object({
    body: z.string(),
    user,
    html_url: z.string(),
    path: z.string().optional(),
  }),
});

const githubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  state_reason: z.string().nullable().optional(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  assignee: user,
  html_url: z.string(),
  pull_request: z.object({}).nullable().optional(),
});

const issuesSchema = z.object({
  action: z.string(),
  issue: githubIssueSchema,
  label: z.object({ name: z.string() }).optional(),
  changes: z
    .object({ title: z.unknown().optional(), body: z.unknown().optional() })
    .optional(),
  repository,
  sender: user,
});

const issueCommentSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number(),
    pull_request: z.object({}).nullable().optional(),
  }),
  comment: z.object({ body: z.string(), user, html_url: z.string() }),
  repository,
  sender: user,
});

const plainIssueCommentSchema = issueCommentSchema.extend({
  issue: githubIssueSchema,
  comment: z.object({ id: z.number(), body: z.string(), user }),
});

const checkSchema = z.object({
  repository,
  check_run: z.object({ head_sha: z.string() }).optional(),
  check_suite: z.object({ head_sha: z.string() }).optional(),
});

const deploymentStatusSchema = z.object({
  repository,
  sender: user,
  deployment_status: z.object({
    state: z.string(),
    target_url: z.string().nullable().optional(),
    environment_url: z.string().nullable().optional(),
  }),
  deployment: z.object({
    id: z.number(),
    sha: z.string(),
    ref: z.string(),
    environment: z.string(),
  }),
});

const workflowRunSchema = z.object({
  action: z.string(),
  repository,
  sender: user,
  workflow_run: z.object({
    id: z.number(),
    name: z.string().nullable().optional(),
    head_sha: z.string(),
    head_branch: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string(),
  }),
});

const reviewKinds: Record<string, WebhookActivity["kind"]> = {
  approved: "review_approved",
  changes_requested: "review_changes_requested",
  commented: "review_commented",
};

function currentIssue(issue: z.infer<typeof githubIssueSchema>) {
  return issueFields({
    title: issue.title,
    body: issue.body,
    state:
      issue.state === "open"
        ? "open"
        : issue.state_reason === "not_planned"
          ? "not_planned"
          : "completed",
    labels: issue.labels.map((label) => label.name),
    assignee: issue.assignee?.login,
    url: issue.html_url,
  });
}

function issueChanges(
  data: z.infer<typeof issuesSchema>,
  current: GitIssueFields,
): GitIssueUpdate {
  const label = data.label ? issueLabelNames([data.label.name]) : [];
  return {
    ...(data.action === "edited" && data.changes?.title
      ? { title: current.title }
      : {}),
    ...(data.action === "edited" && data.changes?.body
      ? { body: current.body }
      : {}),
    ...(data.action === "closed" || data.action === "reopened"
      ? { state: current.state }
      : {}),
    ...(data.action === "assigned" || data.action === "unassigned"
      ? { assignee: current.assignee }
      : {}),
    addLabels: data.action === "labeled" ? label : [],
    removeLabels: data.action === "unlabeled" ? label : [],
  };
}

export function parseGitHubWebhook(
  event: string,
  payload: unknown,
): ParsedWebhook | null {
  if (event === "push") {
    const push = pushSchema.safeParse(payload);
    if (!push.success) return null;
    const data = push.data;
    const before = data.created ? zeroSha : data.before;
    const after = data.deleted ? zeroSha : data.after;
    return parsedWebhook(data.repository.id, {
      sender: data.sender?.login ?? null,
      deployment: tagDeployment(data.ref, after, before === zeroSha),
      activities: pushActivities({
        ref: data.ref,
        before,
        after,
        forced: data.forced ?? false,
        compareUrl: data.compare ?? null,
        commits: data.commits.map((commit) => ({
          id: commit.id,
          message: commit.message,
          author: commit.author.username ?? commit.author.name ?? "",
        })),
      }),
    });
  }
  if (event === "pull_request") {
    const parsed = pullRequestSchema.safeParse(payload);
    if (!parsed.success) return null;
    return parsedWebhook(parsed.data.repository.id, {
      sender: parsed.data.sender?.login ?? null,
      pullRequest: githubPullRequest(parsed.data.pull_request),
    });
  }
  if (event === "pull_request_review") {
    const parsed = reviewSchema.safeParse(payload);
    if (!parsed.success) return null;
    const { review, pull_request: pullRequest, action } = parsed.data;
    const kind =
      action === "dismissed"
        ? "review_dismissed"
        : action === "submitted"
          ? reviewKinds[review.state.toLowerCase()]
          : undefined;
    const body = review.body ?? "";
    return parsedWebhook(parsed.data.repository.id, {
      sender: parsed.data.sender?.login ?? null,
      pullRequest: githubPullRequest(pullRequest),
      staleNumber: pullRequest.number,
      activities:
        kind && (kind !== "review_commented" || body.trim())
          ? [
              {
                kind,
                pullRequestNumber: pullRequest.number,
                review: {
                  state: review.state.toLowerCase(),
                  body: body.slice(0, 20_000),
                  author: review.user?.login ?? "",
                },
              },
            ]
          : [],
    });
  }
  if (event === "pull_request_review_comment") {
    const parsed = reviewCommentSchema.safeParse(payload);
    if (!parsed.success || parsed.data.action !== "created") return null;
    const { comment, pull_request: pullRequest } = parsed.data;
    return parsedWebhook(parsed.data.repository.id, {
      sender: parsed.data.sender?.login ?? null,
      activities: [
        {
          kind: "comment_created",
          pullRequestNumber: pullRequest.number,
          comment: {
            body: comment.body.slice(0, 20_000),
            author: comment.user?.login ?? "",
            url: comment.html_url,
            path: comment.path ?? null,
          },
        },
      ],
    });
  }
  if (event === "issues") {
    const parsed = issuesSchema.safeParse(payload);
    if (!parsed.success || parsed.data.issue.pull_request) return null;
    const current = currentIssue(parsed.data.issue);
    if (!current) return null;
    return parsedWebhook(parsed.data.repository.id, {
      sender: parsed.data.sender?.login ?? null,
      issue: {
        number: parsed.data.issue.number,
        current,
        changes: issueChanges(parsed.data, current),
        comment: null,
        removed:
          parsed.data.action === "deleted" ||
          parsed.data.action === "transferred",
      },
    });
  }
  if (event === "issue_comment") {
    const plain = plainIssueCommentSchema.safeParse(payload);
    if (
      plain.success &&
      plain.data.action === "created" &&
      !plain.data.issue.pull_request
    ) {
      const { comment, issue } = plain.data;
      const current = currentIssue(issue);
      if (!current) return null;
      return parsedWebhook(plain.data.repository.id, {
        sender: plain.data.sender?.login ?? null,
        issue: {
          number: issue.number,
          current,
          changes: { addLabels: [], removeLabels: [] },
          comment: {
            externalId: String(comment.id),
            body: comment.body.slice(0, 20_000),
            author: comment.user?.login ?? "",
          },
          removed: false,
        },
      });
    }
    const parsed = issueCommentSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.action !== "created" ||
      !parsed.data.issue.pull_request
    )
      return null;
    const { comment, issue } = parsed.data;
    return parsedWebhook(parsed.data.repository.id, {
      sender: parsed.data.sender?.login ?? null,
      activities: [
        {
          kind: "comment_created",
          pullRequestNumber: issue.number,
          comment: {
            body: comment.body.slice(0, 20_000),
            author: comment.user?.login ?? "",
            url: comment.html_url,
            path: null,
          },
        },
      ],
    });
  }
  if (event === "check_run" || event === "check_suite") {
    const parsed = checkSchema.safeParse(payload);
    if (!parsed.success) return null;
    const sha =
      parsed.data.check_run?.head_sha ?? parsed.data.check_suite?.head_sha;
    return sha
      ? parsedWebhook(parsed.data.repository.id, { staleSha: sha })
      : null;
  }
  if (event === "deployment_status") {
    const parsed = deploymentStatusSchema.safeParse(payload);
    if (!parsed.success || parsed.data.deployment_status.state !== "success")
      return null;
    const { deployment, deployment_status: status } = parsed.data;
    return parsedWebhook(parsed.data.repository.id, {
      sender: parsed.data.sender?.login ?? null,
      deployment: {
        source: "deployment",
        environment: deployment.environment,
        version: (/^[0-9a-f]{40}$/.test(deployment.ref)
          ? deployment.sha.slice(0, 12)
          : deployment.ref
        ).slice(0, 40),
        sha: deployment.sha,
        externalId: `deployment:${deployment.id}`,
        url: status.environment_url || status.target_url || null,
      },
    });
  }
  if (event === "workflow_run") {
    const parsed = workflowRunSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.action !== "completed" ||
      parsed.data.workflow_run.conclusion !== "success"
    )
      return null;
    const run = parsed.data.workflow_run;
    return parsedWebhook(parsed.data.repository.id, {
      sender: parsed.data.sender?.login ?? null,
      deployment: {
        source: "workflow_run",
        environment: run.name ?? null,
        version: run.head_sha.slice(0, 12),
        sha: run.head_sha,
        externalId: `workflow_run:${run.id}`,
        url: run.html_url,
      },
    });
  }
  return null;
}
