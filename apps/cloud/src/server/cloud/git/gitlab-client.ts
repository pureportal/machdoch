import { z } from "zod";
import type {
  GitAvailableRepository,
  GitCheckRun,
  GitMergeInput,
  GitPullRequestFile,
  GitReview,
  GitReviewComment,
  GitReviewInput,
} from "../../../lib/cloud-git-contract";
import { checksState, type CheckRunState } from "../../../lib/git-automation";
import { CloudError } from "../access";
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
  merged_at: z.string().nullable().optional(),
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
    mergedAt: request.merged_at ?? null,
  };
}

const statusSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  target_url: z.string().nullable().optional(),
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
  note_events: true,
  pipeline_events: true,
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
    const statuses = await this.request(
      `${this.project(fullName)}/repository/commits/${headSha}/statuses?per_page=100`,
      z.array(statusSchema),
    );
    const latest = new Map<string, z.infer<typeof statusSchema>>();
    for (const status of statuses)
      if ((latest.get(status.name)?.id ?? -1) < status.id)
        latest.set(status.name, status);
    const runs: GitCheckRun[] = [...latest.values()].map((status) => ({
      name: status.name,
      state: statusState(status.status),
      url: status.target_url ?? null,
    }));
    return { conclusion: checksState(runs.map((run) => run.state)), runs };
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
