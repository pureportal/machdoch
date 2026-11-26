import { z } from "zod";
import type {
  GitAvailableRepository,
  GitCommit,
  GitConversationEntry,
  GitMergeInput,
  GitMergeMethod,
  GitPullRequestFile,
  GitReview,
  GitReviewComment,
  GitReviewInput,
} from "../../../lib/cloud-git-contract";
import type { GitMergePolicy } from "../../../lib/auto-merge";
import {
  checkRunState,
  checksState,
  type CheckRunState,
} from "../../../lib/git-automation";
import {
  maximumPatchCharacters,
  type GitAccess,
  type GitChecks,
  type GitClient,
  type GitCommitStatus,
  type GitComparison,
  type GitIssueUpdate,
  type GitPullRequestDraft,
  type GitPullRequestRecord,
  type GitRepositoryRecord,
  type GitWebhookTarget,
} from "./git-client";
import { CloudError } from "../access";
import {
  absentAsNull,
  gitRequest,
  gitTextTail,
  type GitRequestInit,
} from "./git-http";
import {
  checkLogByteLimit,
  type GitCheckLog,
} from "../../../lib/pull-request-fixes";

export const githubWebhookEvents = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "check_run",
  "check_suite",
  "deployment_status",
  "workflow_run",
];

const repositorySchema = z.object({
  id: z.number(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  html_url: z.string(),
});

const branchRulesSchema = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({
        required_status_checks: z
          .array(z.object({ context: z.string() }))
          .optional(),
        required_approving_review_count: z.number().optional(),
        require_code_owner_review: z.boolean().optional(),
      })
      .optional(),
  }),
);

const branchSchema = z.object({
  protected: z.boolean(),
  protection: z
    .object({
      required_status_checks: z
        .object({ contexts: z.array(z.string()) })
        .nullable()
        .optional(),
    })
    .optional(),
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
  auto_merge: z.object({}).nullable().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changed_files: z.number().optional(),
  updated_at: z.string(),
  created_at: z.string().optional(),
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
    autoMerge: Boolean(pullRequest.auto_merge),
    additions: pullRequest.additions ?? null,
    deletions: pullRequest.deletions ?? null,
    changedFiles: pullRequest.changed_files ?? null,
    updatedAt: pullRequest.updated_at,
    openedAt: pullRequest.created_at ?? null,
    mergedAt: pullRequest.merged_at ?? null,
    requestedReviewers:
      pullRequest.requested_reviewers?.map((reviewer) => reviewer.login) ??
      null,
  };
}

const combinedStatusSchema = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      target_url: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
  ),
});

function commitStatusState(state: string): CheckRunState {
  if (state === "pending") return "pending";
  if (state === "success") return "success";
  return state === "failure" || state === "error" ? "failure" : "skipped";
}

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string().nullable().optional(),
      details_url: z.string().nullable().optional(),
      app: z.object({ slug: z.string() }).nullable().optional(),
      output: z
        .object({
          title: z.string().nullable().optional(),
          summary: z.string().nullable().optional(),
          text: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
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
    return this.send(`${this.access.apiUrl}${path}`, schema, init);
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.access.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private send<T>(
    url: string,
    schema: z.ZodType<T>,
    init: GitRequestInit = {},
  ): Promise<T> {
    return gitRequest("github", this.transport, url, schema, {
      ...init,
      headers: this.headers(),
    });
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const result = await this.send(
      `${this.access.apiUrl.replace(/\/v3\/?$/u, "")}/graphql`,
      z.object({
        data: schema.nullable().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      }),
      { method: "POST", body: { query, variables } },
    );
    if (result.errors?.length || !result.data)
      throw new CloudError(
        502,
        "git_request",
        result.errors?.[0]?.message.slice(0, 300) ??
          "GitHub answered without data.",
      );
    return result.data;
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

  async setAutoMerge(
    fullName: string,
    number: number,
    enabled: boolean,
    method: GitMergeMethod,
  ): Promise<void> {
    const { node_id: id } = await this.request(
      `/repos/${fullName}/pulls/${number}`,
      z.object({ node_id: z.string() }),
    );
    if (enabled)
      await this.graphql(
        "mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }",
        { id, method: method.toUpperCase() },
        z.unknown(),
      );
    else
      await this.graphql(
        "mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }",
        { id },
        z.unknown(),
      );
  }

  async mergePolicy(fullName: string, branch: string): Promise<GitMergePolicy> {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const [rules, current] = await Promise.all([
      this.request(
        `/repos/${fullName}/rules/branches/${ref}`,
        branchRulesSchema,
      ),
      this.request(`/repos/${fullName}/branches/${ref}`, branchSchema),
    ]);
    const classic = current.protected
      ? await this.request(
          `/repos/${fullName}/branches/${ref}/protection/required_pull_request_reviews`,
          z.object({
            required_approving_review_count: z.number().optional(),
            require_code_owner_reviews: z.boolean().optional(),
          }),
        ).catch(absentAsNull)
      : null;
    const pullRequestRules = rules.flatMap((rule) =>
      rule.type === "pull_request" && rule.parameters ? [rule.parameters] : [],
    );
    return {
      requiredChecks: [
        ...new Set([
          ...(current.protection?.required_status_checks?.contexts ?? []),
          ...rules.flatMap(
            (rule) =>
              rule.parameters?.required_status_checks?.map(
                (check) => check.context,
              ) ?? [],
          ),
        ]),
      ],
      requiredApprovals: Math.max(
        classic?.required_approving_review_count ?? 0,
        ...pullRequestRules.map(
          (parameters) => parameters.required_approving_review_count ?? 0,
        ),
      ),
      codeOwnerReviews:
        classic?.require_code_owner_reviews === true ||
        pullRequestRules.some(
          (parameters) => parameters.require_code_owner_review === true,
        ),
      mergeQueue: rules.some((rule) => rule.type === "merge_queue"),
    };
  }

  async enqueue(
    fullName: string,
    number: number,
    headSha: string,
  ): Promise<void> {
    const [owner, name] = fullName.split("/");
    const { repository } = await this.graphql(
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id isInMergeQueue}}}",
      { owner, name, number },
      z.object({
        repository: z.object({
          pullRequest: z.object({
            id: z.string(),
            isInMergeQueue: z.boolean(),
          }),
        }),
      }),
    );
    if (repository.pullRequest.isInMergeQueue) return;
    await this.graphql(
      "mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id}}}",
      { id: repository.pullRequest.id, head: headSha },
      z.object({
        enqueuePullRequest: z.object({
          mergeQueueEntry: z.object({ id: z.string() }),
        }),
      }),
    );
  }

  async teamMembers(team: string): Promise<string[]> {
    const [organization, slug] = team.split("/");
    return (
      await this.request(
        `/orgs/${encodeURIComponent(organization!)}/teams/${encodeURIComponent(slug!)}/members?per_page=100`,
        z.array(z.object({ login: z.string() })),
      )
    ).map((member) => member.login);
  }

  async checks(
    fullName: string,
    _number: number,
    headSha: string,
  ): Promise<GitChecks> {
    const [result, combined] = await Promise.all([
      this.request(
        `/repos/${fullName}/commits/${headSha}/check-runs?per_page=100`,
        checkRunsSchema,
      ),
      this.request(
        `/repos/${fullName}/commits/${headSha}/status`,
        combinedStatusSchema,
      ),
    ]);
    const runs = [
      ...result.check_runs.map((run) => ({
        name: run.name,
        state: checkRunState(run.status, run.conclusion),
        url: run.html_url ?? run.details_url ?? null,
      })),
      ...combined.statuses.map((status) => ({
        name: status.context,
        state: commitStatusState(status.state),
        url: status.target_url ?? null,
      })),
    ];
    return { conclusion: checksState(runs.map((run) => run.state)), runs };
  }

  async failedCheckLogs(
    fullName: string,
    headSha: string,
  ): Promise<GitCheckLog[]> {
    const [result, combined] = await Promise.all([
      this.request(
        `/repos/${fullName}/commits/${headSha}/check-runs?per_page=100`,
        checkRunsSchema,
      ),
      this.request(
        `/repos/${fullName}/commits/${headSha}/status`,
        combinedStatusSchema,
      ),
    ]);
    const runs = await Promise.all(
      result.check_runs
        .filter(
          (run) => checkRunState(run.status, run.conclusion) === "failure",
        )
        .map(async (run) => ({
          name: run.name,
          url: run.html_url ?? run.details_url ?? null,
          log:
            (run.app?.slug === "github-actions"
              ? await gitTextTail(
                  "github",
                  this.transport,
                  `${this.access.apiUrl}/repos/${fullName}/actions/jobs/${run.id}/logs`,
                  this.headers(),
                  checkLogByteLimit,
                ).catch(absentAsNull)
              : null) ??
            [run.output?.title, run.output?.summary, run.output?.text]
              .filter(Boolean)
              .join("\n\n"),
        })),
    );
    return [
      ...runs,
      ...combined.statuses
        .filter((status) => commitStatusState(status.state) === "failure")
        .map((status) => ({
          name: status.context,
          url: status.target_url ?? null,
          log: status.description ?? "",
        })),
    ];
  }

  async mergeBase(
    fullName: string,
    baseRef: string,
    headSha: string,
  ): Promise<{ baseSha: string; mergeBase: string }> {
    const compared = await this.request(
      `/repos/${fullName}/compare/${encodeURIComponent(baseRef)}...${headSha}`,
      z.object({
        base_commit: z.object({ sha: z.string() }),
        merge_base_commit: z.object({ sha: z.string() }),
      }),
    );
    return {
      baseSha: compared.base_commit.sha,
      mergeBase: compared.merge_base_commit.sha,
    };
  }

  async compare(
    fullName: string,
    baseSha: string,
    headSha: string,
  ): Promise<GitComparison> {
    const compared = await this.request(
      `/repos/${fullName}/compare/${baseSha}...${headSha}`,
      z.object({
        commits: z.array(
          z.object({
            sha: z.string(),
            commit: z.object({ message: z.string() }),
          }),
        ),
        files: z.array(z.object({ filename: z.string() })).default([]),
      }),
    );
    return {
      commits: compared.commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
      })),
      files: compared.files.map((file) => file.filename),
    };
  }

  async commitStatus(
    fullName: string,
    sha: string,
    status: GitCommitStatus,
  ): Promise<void> {
    await this.request(
      `/repos/${fullName}/statuses/${sha}`,
      z.object({ id: z.number() }),
      {
        method: "POST",
        body: {
          state: status.state,
          context: status.context,
          description: status.description.slice(0, 140),
          target_url: status.targetUrl,
        },
      },
    );
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

  async updateIssue(
    fullName: string,
    number: number,
    update: GitIssueUpdate,
  ): Promise<void> {
    const path = `/repos/${fullName}/issues/${number}`;
    const fields = {
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.body === undefined ? {} : { body: update.body }),
      ...(update.state === undefined
        ? {}
        : update.state === "open"
          ? { state: "open" }
          : { state: "closed", state_reason: update.state }),
      ...(update.assignee === undefined
        ? {}
        : { assignees: update.assignee ? [update.assignee] : [] }),
    };
    if (Object.keys(fields).length)
      await this.request(path, z.unknown(), { method: "PATCH", body: fields });
    if (update.addLabels.length)
      await this.request(`${path}/labels`, z.unknown(), {
        method: "POST",
        body: { labels: update.addLabels },
      });
    for (const label of update.removeLabels)
      await this.request(
        `${path}/labels/${encodeURIComponent(label)}`,
        z.unknown(),
        { method: "DELETE" },
      ).catch(absentAsNull);
  }

  async commentOnIssue(
    fullName: string,
    number: number,
    body: string,
  ): Promise<string> {
    return String(
      (
        await this.request(
          `/repos/${fullName}/issues/${number}/comments`,
          z.object({ id: z.number() }),
          { method: "POST", body: { body } },
        )
      ).id,
    );
  }

  postPullRequestComment(
    fullName: string,
    number: number,
    body: string,
  ): Promise<string> {
    return this.commentOnIssue(fullName, number, body);
  }

  async editPullRequestComment(
    fullName: string,
    _number: number,
    commentId: string,
    body: string,
  ): Promise<void> {
    await this.request(
      `/repos/${fullName}/issues/comments/${commentId}`,
      z.unknown(),
      { method: "PATCH", body: { body } },
    );
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

  async createPullRequest(
    fullName: string,
    input: GitPullRequestDraft,
  ): Promise<GitPullRequestRecord> {
    return githubPullRequest(
      await this.request(`/repos/${fullName}/pulls`, githubPullRequestSchema, {
        method: "POST",
        body: {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        },
      }),
    );
  }

  async closePullRequest(fullName: string, number: number): Promise<void> {
    await this.request(`/repos/${fullName}/pulls/${number}`, z.unknown(), {
      method: "PATCH",
      body: { state: "closed" },
    });
  }

  async deleteBranch(fullName: string, branch: string): Promise<void> {
    await this.request(
      `/repos/${fullName}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      z.unknown(),
      { method: "DELETE" },
    );
  }

  async fileText(
    fullName: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const file = await this.request(
        `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
        z.object({ content: z.string(), encoding: z.literal("base64") }),
      );
      return Buffer.from(file.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof CloudError && error.status === 404) return null;
      throw error;
    }
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
