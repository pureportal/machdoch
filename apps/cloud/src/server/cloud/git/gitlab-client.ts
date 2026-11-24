import { z } from "zod";
import type {
  GitAvailableRepository,
  GitCheckRun,
  GitCommit,
  GitConversationEntry,
  GitMergeInput,
  GitPullRequestFile,
  GitReview,
  GitReviewComment,
  GitReviewInput,
} from "../../../lib/cloud-git-contract";
import type { GitMergePolicy } from "../../../lib/auto-merge";
import { checksState, type CheckRunState } from "../../../lib/git-automation";
import { CloudError } from "../access";
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

const projectSchema = z.object({
  id: z.number(),
  path_with_namespace: z.string(),
  visibility: z.string().optional(),
  default_branch: z.string().nullable().optional(),
  web_url: z.string(),
});

export const gitlabMergeRequestSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  web_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string(),
  detailed_merge_status: z.string().nullable().optional(),
  has_conflicts: z.boolean().optional(),
  changes_count: z.string().nullable().optional(),
  updated_at: z.string(),
  created_at: z.string().optional(),
  merged_at: z.string().nullable().optional(),
  reviewers: z
    .array(z.object({ username: z.string() }))
    .nullable()
    .optional(),
});

const mergeStates: Record<string, string> = {
  mergeable: "clean",
  conflict: "dirty",
  need_rebase: "behind",
  not_approved: "blocked",
  requested_changes: "blocked",
  discussions_not_resolved: "blocked",
  blocked_status: "blocked",
  external_status_checks: "blocked",
  jira_association_missing: "blocked",
  not_open: "blocked",
  draft_status: "draft",
  ci_must_pass: "unstable",
  ci_still_running: "unstable",
};

export function gitlabMergeRequest(
  request: z.infer<typeof gitlabMergeRequestSchema>,
): GitPullRequestRecord {
  const status = request.detailed_merge_status ?? "";
  const changed = Number.parseInt(request.changes_count ?? "", 10);
  return {
    number: request.iid,
    title: request.title,
    body: request.description ?? "",
    url: request.web_url,
    state:
      request.state === "merged"
        ? "merged"
        : request.state === "opened"
          ? "open"
          : "closed",
    draft: request.draft ?? request.work_in_progress ?? false,
    author: request.author?.username ?? null,
    headRef: request.source_branch,
    headSha: request.sha,
    baseRef: request.target_branch,
    mergeable:
      status === "mergeable" ? true : request.has_conflicts ? false : null,
    mergeableState: request.has_conflicts
      ? "dirty"
      : (mergeStates[status] ?? null),
    additions: null,
    deletions: null,
    changedFiles: Number.isFinite(changed) ? changed : null,
    updatedAt: request.updated_at,
    openedAt: request.created_at ?? null,
    mergedAt: request.merged_at ?? null,
    requestedReviewers:
      request.reviewers?.map((reviewer) => reviewer.username) ?? null,
  };
}

const commitSchema = z.object({
  id: z.string(),
  title: z.string(),
  message: z.string().optional(),
  author_name: z.string(),
  created_at: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
});

const statusSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  target_url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const diffSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
  diff: z.string(),
});

const noteSchema = z.object({
  id: z.number(),
  body: z.string(),
  system: z.boolean().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  created_at: z.string(),
  position: z
    .object({
      new_path: z.string().nullable().optional(),
      old_path: z.string().nullable().optional(),
      new_line: z.number().nullable().optional(),
      old_line: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const pendingStatuses = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);

function statusState(status: string): CheckRunState {
  if (pendingStatuses.has(status)) return "pending";
  if (status === "success") return "success";
  return status === "failed" || status === "canceled" ? "failure" : "skipped";
}

function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export const gitlabHookEvents = {
  push_events: true,
  tag_push_events: true,
  merge_requests_events: true,
  issues_events: true,
  note_events: true,
  pipeline_events: true,
  deployment_events: true,
};

export class GitLabClient implements GitClient {
  readonly mergeMethods = ["squash", "merge"] as const;

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
      "gitlab",
      this.transport,
      `${this.access.apiUrl}${path}`,
      schema,
      {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.access.token}`,
        },
      },
    );
  }

  private project(fullName: string): string {
    return `/projects/${encodeURIComponent(fullName)}`;
  }

  private mergeRequestPath(fullName: string, number: number): string {
    return `${this.project(fullName)}/merge_requests/${number}`;
  }

  private rawMergeRequest(fullName: string, number: number) {
    return this.request(
      this.mergeRequestPath(fullName, number),
      gitlabMergeRequestSchema,
    );
  }

  async viewer(): Promise<string> {
    return (await this.request("/user", z.object({ username: z.string() })))
      .username;
  }

  async repositories(): Promise<GitAvailableRepository[]> {
    return (
      await this.request(
        "/projects?membership=true&per_page=100&order_by=last_activity_at&archived=false",
        z.array(projectSchema),
      )
    ).map((project) => ({
      fullName: project.path_with_namespace,
      private: project.visibility !== "public",
    }));
  }

  async repository(fullName: string): Promise<GitRepositoryRecord> {
    const project = await this.request(this.project(fullName), projectSchema);
    return {
      externalId: project.id,
      fullName: project.path_with_namespace,
      private: project.visibility !== "public",
      defaultBranch: project.default_branch ?? "main",
      webUrl: project.web_url,
    };
  }

  async pullRequests(fullName: string): Promise<GitPullRequestRecord[]> {
    return (
      await this.request(
        `${this.project(fullName)}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=50`,
        z.array(gitlabMergeRequestSchema),
      )
    ).map(gitlabMergeRequest);
  }

  async pullRequest(
    fullName: string,
    number: number,
  ): Promise<GitPullRequestRecord> {
    return gitlabMergeRequest(await this.rawMergeRequest(fullName, number));
  }

  async checks(
    fullName: string,
    _number: number,
    headSha: string,
  ): Promise<GitChecks> {
    const runs: GitCheckRun[] = (
      await this.latestStatuses(fullName, headSha)
    ).map((status) => ({
      name: status.name,
      state: statusState(status.status),
      url: status.target_url ?? null,
    }));
    return { conclusion: checksState(runs.map((run) => run.state)), runs };
  }

  private async latestStatuses(fullName: string, headSha: string) {
    const statuses = await this.request(
      `${this.project(fullName)}/repository/commits/${headSha}/statuses?per_page=100`,
      z.array(statusSchema),
    );
    const latest = new Map<string, z.infer<typeof statusSchema>>();
    for (const status of statuses)
      if ((latest.get(status.name)?.id ?? -1) < status.id)
        latest.set(status.name, status);
    return [...latest.values()];
  }

  async failedCheckLogs(
    fullName: string,
    headSha: string,
  ): Promise<GitCheckLog[]> {
    const failed = (await this.latestStatuses(fullName, headSha)).filter(
      (status) => statusState(status.status) === "failure",
    );
    return Promise.all(
      failed.map(async (status) => ({
        name: status.name,
        url: status.target_url ?? null,
        log:
          (await gitTextTail(
            "gitlab",
            this.transport,
            `${this.access.apiUrl}${this.project(fullName)}/jobs/${status.id}/trace`,
            { Authorization: `Bearer ${this.access.token}` },
            checkLogByteLimit,
          ).catch(absentAsNull)) ??
          status.description ??
          "",
      })),
    );
  }

  async mergeBase(
    fullName: string,
    baseRef: string,
    headSha: string,
  ): Promise<{ baseSha: string; mergeBase: string }> {
    const project = this.project(fullName);
    const [branch, merged] = await Promise.all([
      this.request(
        `${project}/repository/branches/${encodeURIComponent(baseRef)}`,
        z.object({ commit: z.object({ id: z.string() }) }),
      ),
      this.request(
        `${project}/repository/merge_base?refs[]=${encodeURIComponent(baseRef)}&refs[]=${headSha}`,
        z.object({ id: z.string() }),
      ),
    ]);
    return { baseSha: branch.commit.id, mergeBase: merged.id };
  }

  async compare(
    fullName: string,
    baseSha: string,
    headSha: string,
  ): Promise<GitComparison> {
    const compared = await this.request(
      `${this.project(fullName)}/repository/compare?from=${baseSha}&to=${headSha}`,
      z.object({
        commits: z.array(commitSchema),
        diffs: z.array(z.object({ new_path: z.string() })).default([]),
      }),
    );
    return {
      commits: compared.commits.map((commit) => ({
        sha: commit.id,
        message: commit.message ?? commit.title,
      })),
      files: compared.diffs.map((diff) => diff.new_path),
    };
  }

  async commitStatus(
    fullName: string,
    sha: string,
    status: GitCommitStatus,
  ): Promise<void> {
    await this.request(
      `${this.project(fullName)}/statuses/${sha}`,
      z.object({ id: z.number() }),
      {
        method: "POST",
        body: {
          state:
            status.state === "success"
              ? "success"
              : status.state === "pending"
                ? "pending"
                : "failed",
          name: status.context,
          description: status.description.slice(0, 255),
          target_url: status.targetUrl,
        },
      },
    );
  }

  async reviews(fullName: string, number: number): Promise<GitReview[]> {
    const path = this.mergeRequestPath(fullName, number);
    const [approvals, reviewers] = await Promise.all([
      this.request(
        `${path}/approvals`,
        z.object({
          approved_by: z
            .array(z.object({ user: z.object({ username: z.string() }) }))
            .default([]),
        }),
      ),
      this.request(
        `${path}/reviewers`,
        z.array(
          z.object({
            user: z.object({ username: z.string() }),
            state: z.string(),
          }),
        ),
      ).catch((error: unknown) => {
        if (error instanceof CloudError && error.status === 404) return [];
        throw error;
      }),
    ]);
    const reviews = new Map<string, GitReview>();
    for (const reviewer of reviewers)
      if (reviewer.state === "requested_changes")
        reviews.set(reviewer.user.username, {
          author: reviewer.user.username,
          state: "CHANGES_REQUESTED",
          submittedAt: null,
        });
    for (const approval of approvals.approved_by)
      reviews.set(approval.user.username, {
        author: approval.user.username,
        state: "APPROVED",
        submittedAt: null,
      });
    return [...reviews.values()];
  }

  async files(fullName: string, number: number): Promise<GitPullRequestFile[]> {
    return (
      await this.request(
        `${this.mergeRequestPath(fullName, number)}/diffs?per_page=100`,
        z.array(diffSchema),
      )
    ).map((file) => ({
      filename: file.new_path,
      previousFilename: file.renamed_file ? file.old_path : null,
      status: file.new_file
        ? "added"
        : file.deleted_file
          ? "removed"
          : file.renamed_file
            ? "renamed"
            : "modified",
      ...diffCounts(file.diff),
      patch:
        file.diff && file.diff.length <= maximumPatchCharacters
          ? file.diff
          : null,
    }));
  }

  async reviewComments(
    fullName: string,
    number: number,
  ): Promise<GitReviewComment[]> {
    const [request, discussions] = await Promise.all([
      this.rawMergeRequest(fullName, number),
      this.request(
        `${this.mergeRequestPath(fullName, number)}/discussions?per_page=100`,
        z.array(z.object({ notes: z.array(noteSchema) })),
      ),
    ]);
    return discussions.flatMap((discussion) =>
      discussion.notes
        .filter((note) => !note.system && note.position)
        .map((note) => ({
          id: note.id,
          author: note.author?.username ?? "ghost",
          body: note.body,
          path: note.position?.new_path ?? note.position?.old_path ?? "",
          line: note.position?.new_line ?? note.position?.old_line ?? null,
          diffHunk: "",
          url: `${request.web_url}#note_${note.id}`,
          createdAt: note.created_at,
        })),
    );
  }

  async conversation(
    fullName: string,
    number: number,
  ): Promise<GitConversationEntry[]> {
    const [request, notes] = await Promise.all([
      this.rawMergeRequest(fullName, number),
      this.request(
        `${this.mergeRequestPath(fullName, number)}/notes?sort=asc&order_by=created_at&per_page=100`,
        z.array(noteSchema),
      ),
    ]);
    return notes
      .filter((note) => !note.system && !note.position)
      .map((note) => ({
        id: `note-${note.id}`,
        kind: "comment" as const,
        author: note.author?.username ?? "ghost",
        body: note.body,
        state: null,
        url: `${request.web_url}#note_${note.id}`,
        createdAt: note.created_at,
      }));
  }

  async commits(fullName: string, number: number): Promise<GitCommit[]> {
    return (
      await this.request(
        `${this.mergeRequestPath(fullName, number)}/commits?per_page=100`,
        z.array(commitSchema),
      )
    ).map((commit) => ({
      sha: commit.id,
      message: commit.message ?? commit.title,
      author: commit.author_name,
      url: commit.web_url ?? null,
      committedAt: commit.created_at ?? null,
    }));
  }

  async merge(
    fullName: string,
    number: number,
    input: GitMergeInput,
  ): Promise<void> {
    if (input.method === "rebase")
      throw new CloudError(
        422,
        "git_merge_method",
        "GitLab merges with the project's merge method. Choose merge or squash.",
      );
    await this.request(
      `${this.mergeRequestPath(fullName, number)}/merge`,
      z.object({ iid: z.number() }),
      {
        method: "PUT",
        body: { sha: input.headSha, squash: input.method === "squash" },
      },
    );
  }

  async mergePolicy(fullName: string, branch: string): Promise<GitMergePolicy> {
    const [project, protection] = await Promise.all([
      this.request(
        this.project(fullName),
        z.object({ merge_trains_enabled: z.boolean().optional() }),
      ),
      this.request(
        `${this.project(fullName)}/protected_branches/${encodeURIComponent(branch)}`,
        z.object({ code_owner_approval_required: z.boolean().optional() }),
      ).catch(absentAsNull),
    ]);
    return {
      requiredChecks: [],
      requiredApprovals: 0,
      codeOwnerReviews: protection?.code_owner_approval_required === true,
      mergeQueue: project.merge_trains_enabled === true,
    };
  }

  async enqueue(
    fullName: string,
    number: number,
    headSha: string,
  ): Promise<void> {
    const path = `${this.project(fullName)}/merge_trains/merge_requests/${number}`;
    const queued = await this.request(path, z.object({ id: z.number() })).catch(
      absentAsNull,
    );
    if (queued) return;
    await this.request(path, z.unknown(), {
      method: "POST",
      body: { sha: headSha },
    });
  }

  async teamMembers(team: string): Promise<string[]> {
    return (
      await this.request(
        `/groups/${encodeURIComponent(team)}/members/all?per_page=100`,
        z.array(z.object({ username: z.string() })),
      )
    ).map((member) => member.username);
  }

  async updateBranch(
    fullName: string,
    number: number,
    headSha: string,
  ): Promise<void> {
    const current = await this.rawMergeRequest(fullName, number);
    if (current.sha !== headSha)
      throw new CloudError(
        409,
        "git_head_changed",
        "The branch has new commits. Reload and try again.",
      );
    await this.request(
      `${this.mergeRequestPath(fullName, number)}/rebase`,
      z.object({ rebase_in_progress: z.boolean().optional() }),
      { method: "PUT" },
    );
  }

  async comment(
    fullName: string,
    number: number,
    body: string,
  ): Promise<string> {
    const [request, note] = await Promise.all([
      this.rawMergeRequest(fullName, number),
      this.request(
        `${this.mergeRequestPath(fullName, number)}/notes`,
        z.object({ id: z.number() }),
        { method: "POST", body: { body } },
      ),
    ]);
    return `${request.web_url}#note_${note.id}`;
  }

  private async userId(login: string): Promise<number> {
    const user = (
      await this.request(
        `/users?username=${encodeURIComponent(login)}`,
        z.array(z.object({ id: z.number() })),
      )
    )[0];
    if (!user)
      throw new CloudError(
        422,
        "git_user_unavailable",
        `GitLab has no user ${login}.`,
      );
    return user.id;
  }

  async updateIssue(
    fullName: string,
    number: number,
    update: GitIssueUpdate,
  ): Promise<void> {
    await this.request(
      `${this.project(fullName)}/issues/${number}`,
      z.unknown(),
      {
        method: "PUT",
        body: {
          ...(update.title === undefined ? {} : { title: update.title }),
          ...(update.body === undefined ? {} : { description: update.body }),
          ...(update.state === undefined
            ? {}
            : { state_event: update.state === "open" ? "reopen" : "close" }),
          ...(update.addLabels.length
            ? { add_labels: update.addLabels.join(",") }
            : {}),
          ...(update.removeLabels.length
            ? { remove_labels: update.removeLabels.join(",") }
            : {}),
          ...(update.assignee === undefined
            ? {}
            : {
                assignee_ids: update.assignee
                  ? [await this.userId(update.assignee)]
                  : [],
              }),
        },
      },
    );
  }

  async commentOnIssue(
    fullName: string,
    number: number,
    body: string,
  ): Promise<string> {
    return String(
      (
        await this.request(
          `${this.project(fullName)}/issues/${number}/notes`,
          z.object({ id: z.number() }),
          { method: "POST", body: { body } },
        )
      ).id,
    );
  }

  async postPullRequestComment(
    fullName: string,
    number: number,
    body: string,
  ): Promise<string> {
    return String(
      (
        await this.request(
          `${this.mergeRequestPath(fullName, number)}/notes`,
          z.object({ id: z.number() }),
          { method: "POST", body: { body } },
        )
      ).id,
    );
  }

  async editPullRequestComment(
    fullName: string,
    number: number,
    commentId: string,
    body: string,
  ): Promise<void> {
    await this.request(
      `${this.mergeRequestPath(fullName, number)}/notes/${commentId}`,
      z.unknown(),
      { method: "PUT", body: { body } },
    );
  }

  async review(
    fullName: string,
    number: number,
    input: { decision: GitReviewInput; body: string; headSha: string },
  ): Promise<void> {
    const path = this.mergeRequestPath(fullName, number);
    if (input.body) await this.comment(fullName, number, input.body);
    if (input.decision === "approve")
      await this.request(`${path}/approve`, z.object({}), {
        method: "POST",
        body: { sha: input.headSha },
      });
    if (input.decision === "request_changes")
      await this.request(`${path}/unapprove`, z.object({}), {
        method: "POST",
      }).catch((error: unknown) => {
        if (!(error instanceof CloudError && error.status === 404)) throw error;
      });
  }

  async retarget(
    fullName: string,
    number: number,
    baseRef: string,
  ): Promise<void> {
    await this.request(
      this.mergeRequestPath(fullName, number),
      z.object({ iid: z.number() }),
      { method: "PUT", body: { target_branch: baseRef } },
    );
  }

  private hookConfig(target: GitWebhookTarget) {
    return {
      url: target.url,
      token: target.secret,
      enable_ssl_verification: true,
      ...gitlabHookEvents,
    };
  }

  async createPullRequest(
    fullName: string,
    input: GitPullRequestDraft,
  ): Promise<GitPullRequestRecord> {
    return gitlabMergeRequest(
      await this.request(
        `${this.project(fullName)}/merge_requests`,
        gitlabMergeRequestSchema,
        {
          method: "POST",
          body: {
            title: input.title,
            description: input.body,
            source_branch: input.head,
            target_branch: input.base,
            remove_source_branch: true,
          },
        },
      ),
    );
  }

  async closePullRequest(fullName: string, number: number): Promise<void> {
    await this.request(this.mergeRequestPath(fullName, number), z.unknown(), {
      method: "PUT",
      body: { state_event: "close" },
    });
  }

  async deleteBranch(fullName: string, branch: string): Promise<void> {
    await this.request(
      `${this.project(fullName)}/repository/branches/${encodeURIComponent(branch)}`,
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
        `${this.project(fullName)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
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
        `${this.project(fullName)}/hooks`,
        z.object({ id: z.number() }),
        {
          method: "POST",
          body: this.hookConfig(target),
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
      `${this.project(fullName)}/hooks/${id}`,
      z.object({ id: z.number() }),
      { method: "PUT", body: this.hookConfig(target) },
    );
  }

  async deleteWebhook(fullName: string, id: number): Promise<void> {
    await this.request(`${this.project(fullName)}/hooks/${id}`, z.unknown(), {
      method: "DELETE",
    });
  }
}
