import { z } from "zod";
import type {
  GitHubCheckRun,
  GitHubMergeInput,
  GitHubPullRequestFile,
  GitHubReview,
  GitHubReviewComment,
} from "../../../lib/cloud-github-contract";
import {
  checkRunState,
  checksState,
  reviewDecision,
  type GitHubChecksState,
  type GitHubReviewDecision,
} from "../../../lib/github-automation";
import { CloudError } from "../access";

const requestTimeoutMs = 15_000;
const maximumPatchCharacters = 40_000;

export interface GitHubAccess {
  apiUrl: string;
  token: string;
}

const repositorySchema = z.object({
  id: z.number(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
});
export type GitHubRepositoryRecord = z.infer<typeof repositorySchema>;

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
});
export type GitHubPullRequestRecord = z.infer<typeof githubPullRequestSchema>;

const checkRunsSchema = z.object({
  total_count: z.number(),
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
  user: z.object({ login: z.string() }).nullable(),
  state: z.string(),
  submitted_at: z.string().nullable().optional(),
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

export class GitHubClient {
  constructor(
    private readonly access: GitHubAccess,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(`${this.access.apiUrl}${path}`, {
        method: init.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.access.token}`,
          "User-Agent": "machdoch-cloud",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new CloudError(
        502,
        "github_unreachable",
        "GitHub is unreachable. Check the API address and try again.",
      );
    }
    const payload: unknown =
      response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof payload.message === "string"
          ? payload.message.slice(0, 300)
          : `GitHub answered with ${response.status}.`;
      throw new CloudError(
        [401, 403, 422].includes(response.status)
          ? 422
          : response.status === 404
            ? 404
            : response.status === 405 || response.status === 409
              ? 409
              : 502,
        response.status === 401 ? "github_token" : "github_request",
        response.status === 401
          ? "GitHub rejected the token. Enter a valid token."
          : message,
      );
    }
    return schema.parse(payload);
  }

  async viewer(): Promise<string> {
    return (await this.request("/user", z.object({ login: z.string() }))).login;
  }

  repositories(): Promise<GitHubRepositoryRecord[]> {
    return this.request(
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      z.array(repositorySchema),
    );
  }

  repository(fullName: string): Promise<GitHubRepositoryRecord> {
    return this.request(`/repos/${fullName}`, repositorySchema);
  }

  pullRequests(fullName: string): Promise<GitHubPullRequestRecord[]> {
    return this.request(
      `/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
      z.array(githubPullRequestSchema),
    );
  }

  pullRequest(
    fullName: string,
    number: number,
  ): Promise<GitHubPullRequestRecord> {
    return this.request(
      `/repos/${fullName}/pulls/${number}`,
      githubPullRequestSchema,
    );
  }

  async merge(
    fullName: string,
    number: number,
    input: GitHubMergeInput,
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
    sha: string,
  ): Promise<{ conclusion: GitHubChecksState; runs: GitHubCheckRun[] }> {
    const result = await this.request(
      `/repos/${fullName}/commits/${sha}/check-runs?per_page=100`,
      checkRunsSchema,
    );
    const runs = result.check_runs.map((run) => ({
      name: run.name,
      state: checkRunState(run.status, run.conclusion),
      url: run.html_url ?? run.details_url ?? null,
    }));
    return { conclusion: checksState(runs.map((run) => run.state)), runs };
  }

  async reviews(fullName: string, number: number): Promise<GitHubReview[]> {
    const reviews = await this.request(
      `/repos/${fullName}/pulls/${number}/reviews?per_page=100`,
      z.array(reviewSchema),
    );
    const latest = new Map<string, GitHubReview>();
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

  async reviewDecision(
    fullName: string,
    number: number,
  ): Promise<GitHubReviewDecision> {
    return reviewDecision(
      (await this.reviews(fullName, number)).map((review) => review.state),
    );
  }

  async files(
    fullName: string,
    number: number,
  ): Promise<GitHubPullRequestFile[]> {
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
  ): Promise<GitHubReviewComment[]> {
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

  async createWebhook(
    fullName: string,
    url: string,
    secret: string,
  ): Promise<number> {
    return (
      await this.request(
        `/repos/${fullName}/hooks`,
        z.object({ id: z.number() }),
        {
          method: "POST",
          body: {
            name: "web",
            active: true,
            events: [
              "pull_request",
              "pull_request_review",
              "check_run",
              "check_suite",
            ],
            config: {
              url,
              content_type: "json",
              secret,
              insecure_ssl: "0",
            },
          },
        },
      )
    ).id;
  }

  async deleteWebhook(fullName: string, id: number): Promise<void> {
    await this.request(`/repos/${fullName}/hooks/${id}`, z.null(), {
      method: "DELETE",
    });
  }
}
