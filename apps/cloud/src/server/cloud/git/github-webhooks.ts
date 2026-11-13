import { z } from "zod";
import { githubPullRequest, githubPullRequestSchema } from "./github-client";
import {
  parsedWebhook,
  pushActivities,
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

const checkSchema = z.object({
  repository,
  check_run: z.object({ head_sha: z.string() }).optional(),
  check_suite: z.object({ head_sha: z.string() }).optional(),
});

const reviewKinds: Record<string, WebhookActivity["kind"]> = {
  approved: "review_approved",
  changes_requested: "review_changes_requested",
  commented: "review_commented",
};

export function parseGitHubWebhook(
  event: string,
  payload: unknown,
): ParsedWebhook | null {
  if (event === "push") {
    const push = pushSchema.safeParse(payload);
    if (!push.success) return null;
    const data = push.data;
    return parsedWebhook(data.repository.id, {
      sender: data.sender?.login ?? null,
      activities: pushActivities({
        ref: data.ref,
        before: data.created ? zeroSha : data.before,
        after: data.deleted ? zeroSha : data.after,
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
  if (event === "issue_comment") {
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
  return null;
}
