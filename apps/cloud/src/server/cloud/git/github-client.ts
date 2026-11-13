import { z } from "zod";
import type {
  GitAvailableRepository,
  GitCommit,
  GitConversationEntry,
  GitMergeInput,
  GitPullRequestFile,
  GitReview,
  GitReviewComment,
  GitReviewInput,
} from "../../../lib/cloud-git-contract";
import { checkRunState, checksState } from "../../../lib/git-automation";
import {
  maximumPatchCharacters,
  type GitAccess,
  type GitChecks,
  type GitClient,
  type GitPullRequestRecord,
  type GitRepositoryRecord,
  type GitWebhookTarget,
} from "./git-client";
import { gitRequest, type GitRequestInit } from "./git-http";

export const githubWebhookEvents = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_run",
  "check_suite",
];

const repositorySchema = z.object({
  id: z.number(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  html_url: z.string(),
});

export const githubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merged: z.boolean().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().nullable().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changed_files: z.number().optional(),
  updated_at: z.string(),
  requested_reviewers: z
    .array(z.object({ login: z.string() }))
    .nullable()
    .optional(),
});

export function githubPullRequest(
  pullRequest: z.infer<typeof githubPullRequestSchema>,
): GitPullRequestRecord {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body ?? "",
    url: pullRequest.html_url,
    state:
      pullRequest.merged_at || pullRequest.merged
        ? "merged"
        : pullRequest.state,
    draft: pullRequest.draft === true,
    author: pullRequest.user?.login ?? null,
    headRef: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    baseRef: pullRequest.base.ref,
    mergeable: pullRequest.mergeable ?? null,
    mergeableState: pullRequest.mergeable_state ?? null,
    additions: pullRequest.additions ?? null,
    deletions: pullRequest.deletions ?? null,
    changedFiles: pullRequest.changed_files ?? null,
    updatedAt: pullRequest.updated_at,
    mergedAt: pullRequest.merged_at ?? null,
    requestedReviewers:
      pullRequest.requested_reviewers?.map((reviewer) => reviewer.login) ??
      null,
  };
}

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string().nullable().optional(),
      details_url: z.string().nullable().optional(),
    }),
  ),
});

const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
});

const reviewSchema = z.object({
  id: z.number().optional(),
  user: z.object({ login: z.string() }).nullable(),
  state: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});

const issueCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  created_at: z.string(),
});

const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string().nullable().optional(),
  author: z.object({ login: z.string() }).nullable().optional(),
  commit: z.object({
    message: z.string(),
    author: z
      .object({ name: z.string(), date: z.string().optional() })
      .nullable()
      .optional(),
  }),
});

const reviewCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  path: z.string(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
  diff_hunk: z.string(),
  html_url: z.string(),
  created_at: z.string(),
});

const reviewEvents: Record<GitReviewInput, string> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

export class GitHubClient implements GitClient {
  readonly mergeMethods = ["squash", "merge", "rebase"] as const;

  constructor(
    private readonly access: GitAccess,
    private readonly transport: typeof fetch,
  ) {}

  private request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: GitRequestInit = {},
  ): Promise<T> {
    return gitRequest(
      "github",
      this.transport,
      `${this.access.apiUrl}${path}`,
      schema,
      {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.access.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
  }

  async viewer(): Promise<string> {
    return (await this.request("/user", z.object({ login: z.string() }))).login;
  }

  async repositories(): Promise<GitAvailableRepository[]> {
    return (
      await this.request(
        "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        z.array(repositorySchema),
      )
    ).map((repository) => ({
      fullName: repository.full_name,
      private: repository.private,
    }));
  }

  async repository(fullName: string): Promise<GitRepositoryRecord> {
    const repository = await this.request(
      `/repos/${fullName}`,
      repositorySchema,
    );
    return {
      externalId: repository.id,
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
      webUrl: repository.html_url,
    };
  }

  async pullRequests(fullName: string): Promise<GitPullRequestRecord[]> {
    return (
      await this.request(
        `/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
        z.array(githubPullRequestSchema),
      )
    ).map(githubPullRequest);
  }

  async pullRequest(
    fullName: string,
    number: number,
  ): Promise<GitPullRequestRecord> {
    return githubPullRequest(
      await this.request(
        `/repos/${fullName}/pulls/${number}`,
        githubPullRequestSchema,
      ),
    );
  }

  async merge(
    fullName: string,
    number: number,
    input: GitMergeInput,
  ): Promise<void> {
    await this.request(
      `/repos/${fullName}/pulls/${number}/merge`,
      z.object({ merged: z.boolean() }),
      {
        method: "PUT",
        body: { merge_method: input.method, sha: input.headSha },
      },
    );
  }

  async checks(
    fullName: string,
    _number: number,
    headSha: string,
  ): Promise<GitChecks> {
    const result = await this.request(
      `/repos/${fullName}/commits/${headSha}/check-runs?per_page=100`,
      checkRunsSchema,
    );
    const runs = result.check_runs.map((run) => ({
      name: run.name,
      state: checkRunState(run.status, run.conclusion),
      url: run.html_url ?? run.details_url ?? null,
    }));
    return { conclusion: checksState(runs.map((run) => run.state)), runs };
  }

  async reviews(fullName: string, number: number): Promise<GitReview[]> {
    const reviews = await this.request(
      `/repos/${fullName}/pulls/${number}/reviews?per_page=100`,
      z.array(reviewSchema),
    );
    const latest = new Map<string, GitReview>();
    for (const review of reviews) {
      if (review.state === "COMMENTED" || !review.user) continue;
      latest.set(review.user.login, {
        author: review.user.login,
        state: review.state,
        submittedAt: review.submitted_at ?? null,
      });
    }
    return [...latest.values()];
  }

  async files(fullName: string, number: number): Promise<GitPullRequestFile[]> {
    return (
      await this.request(
        `/repos/${fullName}/pulls/${number}/files?per_page=100`,
        z.array(fileSchema),
      )
    ).map((file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch:
        file.patch && file.patch.length <= maximumPatchCharacters
          ? file.patch
          : null,
    }));
  }

  async updateBranch(
    fullName: string,
    number: number,
    headSha: string,
  ): Promise<void> {
    await this.request(
      `/repos/${fullName}/pulls/${number}/update-branch`,
      z.object({ message: z.string().optional() }),
      { method: "PUT", body: { expected_head_sha: headSha } },
    );
  }

  async reviewComments(
    fullName: string,
    number: number,
  ): Promise<GitReviewComment[]> {
    return (
      await this.request(
        `/repos/${fullName}/pulls/${number}/comments?per_page=100`,
        z.array(reviewCommentSchema),
      )
    ).map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? "ghost",
      body: comment.body,
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
      diffHunk: comment.diff_hunk,
      url: comment.html_url,
      createdAt: comment.created_at,
    }));
  }

  async conversation(
    fullName: string,
    number: number,
  ): Promise<GitConversationEntry[]> {
    const [comments, reviews] = await Promise.all([
      this.request(
        `/repos/${fullName}/issues/${number}/comments?per_page=100`,
        z.array(issueCommentSchema),
      ),
      this.request(
        `/repos/${fullName}/pulls/${number}/reviews?per_page=100`,
        z.array(reviewSchema),
      ),
    ]);
    return [
      ...comments.map((comment) => ({
        id: `comment-${comment.id}`,
        kind: "comment" as const,
        author: comment.user?.login ?? "ghost",
        body: comment.body ?? "",
        state: null,
        url: comment.html_url,
        createdAt: comment.created_at,
      })),
      ...reviews
        .filter(
          (review) =>
            review.submitted_at &&
            (review.state !== "COMMENTED" || review.body?.trim()),
        )
        .map((review, index) => ({
          id: `review-${review.id ?? index}`,
          kind: "review" as const,
          author: review.user?.login ?? "ghost",
          body: review.body ?? "",
          state: review.state,
          url: review.html_url ?? null,
          createdAt: review.submitted_at!,
        })),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async commits(fullName: string, number: number): Promise<GitCommit[]> {
    return (
      await this.request(
        `/repos/${fullName}/pulls/${number}/commits?per_page=100`,
        z.array(commitSchema),
      )
    ).map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
      url: commit.html_url ?? null,
      committedAt: commit.commit.author?.date ?? null,
    }));
  }

  async comment(
    fullName: string,
    number: number,
    body: string,
  ): Promise<string> {
    return (
      await this.request(
        `/repos/${fullName}/issues/${number}/comments`,
        z.object({ html_url: z.string() }),
        { method: "POST", body: { body } },
      )
    ).html_url;
  }

  async review(
    fullName: string,
    number: number,
    input: { decision: GitReviewInput; body: string; headSha: string },
  ): Promise<void> {
    await this.request(
      `/repos/${fullName}/pulls/${number}/reviews`,
      z.object({ id: z.number() }),
      {
        method: "POST",
        body: {
          event: reviewEvents[input.decision],
          commit_id: input.headSha,
          ...(input.body ? { body: input.body } : {}),
        },
      },
    );
  }

  async retarget(
    fullName: string,
    number: number,
    baseRef: string,
  ): Promise<void> {
    await this.request(
      `/repos/${fullName}/pulls/${number}`,
      z.object({ number: z.number() }),
      { method: "PATCH", body: { base: baseRef } },
    );
  }

  private hookConfig(target: GitWebhookTarget) {
    return {
      active: true,
      events: githubWebhookEvents,
      config: {
        url: target.url,
        content_type: "json",
        secret: target.secret,
        insecure_ssl: "0",
      },
    };
  }

  async createWebhook(
    fullName: string,
    target: GitWebhookTarget,
  ): Promise<number> {
    return (
      await this.request(
        `/repos/${fullName}/hooks`,
        z.object({ id: z.number() }),
        {
          method: "POST",
          body: { name: "web", ...this.hookConfig(target) },
        },
      )
    ).id;
  }

  async updateWebhook(
    fullName: string,
    id: number,
    target: GitWebhookTarget,
  ): Promise<void> {
    await this.request(
      `/repos/${fullName}/hooks/${id}`,
      z.object({ id: z.number() }),
      {
        method: "PATCH",
        body: this.hookConfig(target),
      },
    );
  }

  async deleteWebhook(fullName: string, id: number): Promise<void> {
    await this.request(`/repos/${fullName}/hooks/${id}`, z.null(), {
      method: "DELETE",
    });
  }
}
