import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudLinkedIssue,
  CloudPullRequest,
  CloudPullRequestDetails,
  CloudPullRequestList,
  CloudReviewInbox,
  GitIssueCommit,
  GitAutoMergeInput,
  GitMergeInput,
  GitPullRequestFile,
  GitReviewInput,
} from "../../../lib/cloud-git-contract";
import {
  pullRequestStages,
  reviewDecision,
  type PullRequestStage,
} from "../../../lib/git-automation";
import { automationMarker, type GitEventKind } from "../../../lib/git-events";
import { pullRequestStacks } from "../../../lib/pull-request-stacks";
import {
  pullRequestFixSubject,
  type PullRequestFixTask,
} from "../../../lib/pull-request-fixes";
import { pullRequestProfileId } from "../execution/pull-request-tasks";
import type { SettingsCipher } from "../../settings-crypto";
import {
  accessCan,
  CloudError,
  isCloudError,
  requireMembership,
  teamVisibility,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { readIssue } from "../planning";
import { gitClient, type GitCommitStatus } from "./git-client";
import { gitConnection, type GitConnectionRecord } from "./connections";
import { gitEvent, queueGitEvents, type StoredRepository } from "./events";
import {
  organizationAccess,
  type ActingAccess,
  type GitIdentities,
} from "./identity";
import { recordMergedWork, unlinkedMergedPullRequest } from "./merge-issues";
import { eventPullRequest, type CloudGitSync } from "./sync";
import type { GitProvider } from "../../../lib/git-providers";

const reviewEvents: Record<
  GitReviewInput,
  { kind: GitEventKind; state: string }
> = {
  approve: { kind: "review_approved", state: "approved" },
  request_changes: {
    kind: "review_changes_requested",
    state: "changes_requested",
  },
  comment: { kind: "review_commented", state: "commented" },
};
const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const recentDays = 14;
const stackDays = 30;
const listLimit = 300;
const pullRequestColumns = `p.id,r.provider,r.full_name AS repository,p.number,p.title,p.url,p.state,p.draft,p.author,p.head_ref AS "headRef",p.head_sha AS "headSha",
  p.base_ref AS "baseRef",r.default_branch AS "defaultBranch",p.mergeable_state AS "mergeableState",p.additions,p.deletions,p.changed_files AS "changedFiles",
  p.checks,p.review,p.stage,to_char(p.merged_at AT TIME ZONE 'UTC',${timestamp}) AS "mergedAt",
  to_char(p.updated_at AT TIME ZONE 'UTC',${timestamp}) AS "updatedAt",p.repository_id AS "repositoryId",r.connection_id AS "connectionId",
  r.web_url AS "repositoryUrl",p.requested_reviewers AS "requestedReviewers",COALESCE(v.closes,false) AS closes,COALESCE(v.issues,'[]'::jsonb) AS issues`;
const stageOrder = `CASE p.stage ${pullRequestStages.map((stage, index) => `WHEN '${stage}' THEN ${index}`).join(" ")} END`;
const visibleCte = `WITH visible AS (
    SELECT l.pull_request_id,bool_or(l.closes) AS closes,
    jsonb_agg(jsonb_build_object('id',i.id,'identifier',i.identifier,'title',i.title,'statusName',s.name,'state',i.state,'closes',l.closes) ORDER BY i.identifier) AS issues
    FROM cloud_git_pull_request_issues l
    JOIN cloud_issues i ON i.organization_id=l.organization_id AND i.id=l.issue_id
    JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
    JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
    JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
    WHERE l.organization_id=$1 AND ${teamVisibility}
    GROUP BY l.pull_request_id
  )`;
const visibleTables = `cloud_git_pull_requests p
  JOIN cloud_git_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
  LEFT JOIN visible v ON v.pull_request_id=p.id`;
const visibleWhere = `p.organization_id=$1 AND (v.pull_request_id IS NOT NULL OR (NOT EXISTS (
  SELECT 1 FROM cloud_git_pull_request_issues x WHERE x.organization_id=p.organization_id AND x.pull_request_id=p.id)
  AND EXISTS (SELECT 1 FROM cloud_memberships om JOIN cloud_roles orl ON orl.organization_id=om.organization_id AND orl.key=om.role
    WHERE om.organization_id=$1 AND om.user_id=$2 AND orl.scope='organization')))`;

type Row = Omit<CloudPullRequest, "stack"> & {
  repositoryId: string;
  connectionId: string;
  repositoryUrl: string | null;
  issues: CloudLinkedIssue[];
};

type WritablePullRequest = VisiblePullRequest & {
  acting: ActingAccess;
  userId: string;
};

interface VisiblePullRequest {
  pullRequest: CloudPullRequest;
  issues: CloudLinkedIssue[];
  repository: StoredRepository;
  connection: GitConnectionRecord;
  canAct: boolean;
  canFix: boolean;
}

async function visibleRows(
  sql: CloudSql,
  actor: CloudActor,
  where: string,
  parameters: unknown[],
  order = `${stageOrder},p.updated_at DESC`,
): Promise<Row[]> {
  return (
    await sql.query<Row & Record<string, unknown>>(
      `${visibleCte} SELECT ${pullRequestColumns} FROM ${visibleTables}
      WHERE ${visibleWhere} AND ${where} ORDER BY ${order} LIMIT ${listLimit}`,
      [actor.organizationId, actor.userId, ...parameters],
    )
  ).rows;
}

async function withStacks(
  sql: CloudSql,
  actor: CloudActor,
  rows: Row[],
): Promise<
  (CloudPullRequest & {
    issues: CloudLinkedIssue[];
    repositoryId: string;
    connectionId: string;
    repositoryUrl: string | null;
  })[]
> {
  const repositoryIds = [...new Set(rows.map((row) => row.repositoryId))];
  const candidates = repositoryIds.length
    ? await visibleRows(
        sql,
        actor,
        `r.id=ANY($3::uuid[]) AND (p.state='open' OR p.updated_at > clock_timestamp() - interval '${stackDays} days')`,
        [repositoryIds],
        "p.updated_at DESC",
      )
    : [];
  const stacks = pullRequestStacks([
    ...candidates,
    ...rows.filter((row) => !candidates.some((entry) => entry.id === row.id)),
  ]);
  return rows.map((row) => ({ ...row, stack: stacks.get(row.id) ?? null }));
}

function publicPullRequest(
  row: CloudPullRequest & {
    issues?: unknown;
    connectionId?: unknown;
    repositoryUrl?: unknown;
  },
): CloudPullRequest {
  const {
    issues: _issues,
    connectionId: _connection,
    repositoryUrl: _url,
    ...pullRequest
  } = row;
  return pullRequest;
}

export async function readVisiblePullRequest(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<Omit<Row, "issues">> {
  await requireMembership(sql, actor, "git.view");
  const row = (await visibleRows(sql, actor, "p.id=$3", [id]))[0];
  if (!row)
    throw new CloudError(404, "not_found", "Pull request is unavailable.");
  return row;
}

export class CloudGitPullRequests {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly identities: GitIdentities,
    private readonly sync: CloudGitSync,
    private readonly transport: typeof fetch,
  ) {}

  forIssue(actor: CloudActor, issueId: string): Promise<CloudPullRequest[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.view");
      await readIssue(sql, actor, issueId);
      const rows = await visibleRows(
        sql,
        actor,
        "EXISTS (SELECT 1 FROM cloud_git_pull_request_issues y WHERE y.organization_id=p.organization_id AND y.pull_request_id=p.id AND y.issue_id=$3)",
        [issueId],
      );
      const closes = new Map(
        (
          await sql.query<{ pull_request_id: string; closes: boolean }>(
            "SELECT pull_request_id,closes FROM cloud_git_pull_request_issues WHERE organization_id=$1 AND issue_id=$2",
            [actor.organizationId, issueId],
          )
        ).rows.map((row) => [row.pull_request_id, row.closes]),
      );
      return (await withStacks(sql, actor, rows)).map((row) => ({
        ...publicPullRequest(row),
        closes: closes.get(row.id) ?? false,
      }));
    });
  }

  issueCommits(actor: CloudActor, issueId: string): Promise<GitIssueCommit[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.view");
      await readIssue(sql, actor, issueId);
      return (
        await sql.query<
          Omit<GitIssueCommit, "url"> & {
            provider: GitProvider;
            webUrl: string | null;
          }
        >(
          `SELECT c.sha,r.full_name AS repository,c.message,c.author,c.closes,r.provider,r.web_url AS "webUrl",
          to_char(c.linked_at AT TIME ZONE 'UTC',${timestamp}) AS "linkedAt"
          FROM cloud_git_commit_issues c JOIN cloud_git_repositories r ON r.organization_id=c.organization_id AND r.id=c.repository_id
          WHERE c.organization_id=$1 AND c.issue_id=$2 ORDER BY c.linked_at DESC,c.sha LIMIT 100`,
          [actor.organizationId, issueId],
        )
      ).rows.map(({ provider, webUrl, ...commit }) => ({
        ...commit,
        url: webUrl
          ? `${webUrl}/${provider === "gitlab" ? "-/" : ""}commit/${commit.sha}`
          : null,
      }));
    });
  }

  async createIssue(
    actor: CloudActor,
    id: string,
  ): Promise<{ issueId: string }> {
    const { connection, issueId, steps } = await this.database.transaction(
      async (sql) => {
        await requireMembership(sql, actor, "git.act");
        const visible = await this.visible(sql, actor, id);
        const pullRequest = await unlinkedMergedPullRequest(
          sql,
          actor.organizationId,
          id,
        );
        const suggested = await sql.query<{ team_id: string }>(
          "SELECT team_id FROM cloud_git_issue_suggestions WHERE organization_id=$1 AND pull_request_id=$2 FOR UPDATE",
          [actor.organizationId, id],
        );
        const teamId = suggested.rows[0]?.team_id;
        if (!pullRequest || !teamId)
          throw new CloudError(
            409,
            "git_issue_linked",
            "This pull request already has an issue.",
          );
        return {
          connection: visible.connection,
          ...(await recordMergedWork(sql, actor, { ...pullRequest, teamId })),
        };
      },
    );
    await this.sync.applySteps(connection, steps, actor.userId);
    return { issueId };
  }

  list(
    actor: CloudActor,
    stage: PullRequestStage | undefined,
  ): Promise<CloudPullRequestList> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.view");
      const rows = await withStacks(
        sql,
        actor,
        await visibleRows(
          sql,
          actor,
          `(p.state='open' OR p.updated_at > clock_timestamp() - interval '${recentDays} days')`,
          [],
        ),
      );
      const counts = Object.fromEntries(
        pullRequestStages.map((entry) => [
          entry,
          rows.filter((row) => row.stage === entry).length,
        ]),
      ) as Record<PullRequestStage, number>;
      const connected = await sql.query(
        "SELECT 1 FROM cloud_git_connections WHERE organization_id=$1 LIMIT 1",
        [actor.organizationId],
      );
      return {
        connected: connected.rows.length > 0,
        counts,
        pullRequests: rows
          .filter((row) => !stage || row.stage === stage)
          .map((row) => ({
            pullRequest: publicPullRequest(row),
            issues: row.issues,
          })),
      };
    });
  }

  reviews(actor: CloudActor): Promise<CloudReviewInbox> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.view");
      const accounts = (
        await sql.query<{ provider: GitProvider; login: string }>(
          "SELECT provider,login FROM cloud_git_accounts WHERE organization_id=$1 AND user_id=$2 ORDER BY provider",
          [actor.organizationId, actor.userId],
        )
      ).rows;
      const identities = accounts.map(
        (account) => `${account.provider}:${account.login.toLowerCase()}`,
      );
      const rows = identities.length
        ? await withStacks(
            sql,
            actor,
            await visibleRows(
              sql,
              actor,
              `(p.state='open' OR p.updated_at > clock_timestamp() - interval '${recentDays} days')
              AND (r.provider||':'||lower(p.author) = ANY($3::text[])
                OR EXISTS (SELECT 1 FROM unnest(p.requested_reviewers) reviewer WHERE r.provider||':'||lower(reviewer) = ANY($3::text[])))`,
              [identities],
              "p.updated_at DESC",
            ),
          )
        : [];
      return {
        accounts,
        pullRequests: rows.map((row) => ({
          pullRequest: publicPullRequest(row),
          issues: row.issues,
        })),
      };
    });
  }

  private async visible(
    sql: CloudSql,
    actor: CloudActor,
    id: string,
  ): Promise<VisiblePullRequest> {
    const access = await requireMembership(sql, actor, "git.view");
    const row = (await visibleRows(sql, actor, "p.id=$3", [id]))[0];
    if (!row)
      throw new CloudError(404, "not_found", "Pull request is unavailable.");
    const [stacked] = await withStacks(sql, actor, [row]);
    return {
      pullRequest: publicPullRequest(stacked!),
      issues: row.issues,
      repository: {
        id: row.repositoryId,
        connectionId: row.connectionId,
        provider: row.provider,
        fullName: row.repository,
        defaultBranch: row.defaultBranch,
        webUrl: row.repositoryUrl,
      },
      connection: await gitConnection(
        sql,
        this.cipher,
        actor.organizationId,
        row.connectionId,
      ),
      canAct: accessCan(access, "git.act"),
      canFix: accessCan(access, "ai.tasks"),
    };
  }

  find(
    actor: CloudActor,
    repository: string,
    number: number,
  ): Promise<string | null> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.view");
      const [row] = await visibleRows(
        sql,
        actor,
        "lower(r.full_name)=lower($3) AND p.number=$4",
        [repository, number],
      );
      return row?.id ?? null;
    });
  }

  get(actor: CloudActor, id: string): Promise<CloudPullRequest> {
    return this.database.transaction(
      async (sql) => (await this.visible(sql, actor, id)).pullRequest,
    );
  }

  private async writable(
    actor: CloudActor,
    id: string,
  ): Promise<WritablePullRequest> {
    await this.identities.refreshExpiring(actor.organizationId, actor.userId);
    const visible = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.act");
      const current = await this.visible(sql, actor, id);
      return {
        ...current,
        acting: await this.identities.acting(
          sql,
          current.connection,
          actor.userId,
        ),
        userId: actor.userId,
      };
    });
    if (visible.pullRequest.state !== "open")
      throw new CloudError(409, "git_closed", "This pull request is closed.");
    return visible;
  }

  async details(
    actor: CloudActor,
    id: string,
  ): Promise<CloudPullRequestDetails> {
    const visible = await this.database.transaction((sql) =>
      this.visible(sql, actor, id),
    );
    const client = gitClient(visible.connection, this.transport);
    const { repository, number } = visible.pullRequest;
    const [fresh, reviews, comments, conversation, commits] = await Promise.all(
      [
        client.pullRequest(repository, number),
        client.reviews(repository, number),
        client.reviewComments(repository, number),
        client.conversation(repository, number),
        client.commits(repository, number),
      ],
    );
    const checks = await client.checks(repository, number, fresh.headSha);
    await this.sync.store(visible.connection, visible.repository, fresh, {
      signals: {
        checks: checks.conclusion,
        review: reviewDecision(reviews.map((review) => review.state)),
      },
    });
    const { updated, actingAs, issueSuggestion, fixable } =
      await this.database.transaction(async (sql) => {
        const current = await this.visible(sql, actor, id);
        const suggestion = await sql.query(
          "SELECT 1 FROM cloud_git_issue_suggestions WHERE organization_id=$1 AND pull_request_id=$2",
          [actor.organizationId, id],
        );
        return {
          updated: current,
          issueSuggestion: current.canAct && suggestion.rows.length > 0,
          fixable:
            current.canFix &&
            current.pullRequest.state === "open" &&
            (await pullRequestProfileId(sql, actor, id)) !== null,
          actingAs: await this.identities.actingLogin(
            sql,
            current.connection,
            actor.userId,
          ),
        };
      });
    return {
      pullRequest: updated.pullRequest,
      body: fresh.body,
      mergeable: fresh.mergeable,
      checks,
      reviews,
      comments,
      conversation,
      commits: commits.sort((left, right) =>
        (left.committedAt ?? "").localeCompare(right.committedAt ?? ""),
      ),
      issues: updated.issues,
      issueSuggestion,
      canMerge: updated.canAct && updated.pullRequest.state === "open",
      fixable,
      autoMerge: fresh.autoMerge,
      actingAs,
      agentLogin: organizationAccess(updated.connection).login,
      mergeMethods: [...client.mergeMethods],
    };
  }

  async fixSubject(
    actor: CloudActor,
    id: string,
    task: PullRequestFixTask,
  ): Promise<{
    headSha: string;
    objective: string;
    acceptanceCriteria: string;
  }> {
    const visible = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.tasks");
      return this.visible(sql, actor, id);
    });
    const { repository, number, headSha, state } = visible.pullRequest;
    if (state !== "open")
      throw new CloudError(409, "git_closed", "This pull request is closed.");
    const client = gitClient(visible.connection, this.transport);
    const [failures, comments] = await Promise.all([
      task === "checks" ? client.failedCheckLogs(repository, headSha) : [],
      task === "review" ? client.reviewComments(repository, number) : [],
    ]);
    if (task === "checks" && !failures.length)
      throw new CloudError(
        409,
        "checks_passing",
        "No checks failed on the latest commit.",
      );
    if (task === "review" && !comments.length)
      throw new CloudError(
        409,
        "no_review_comments",
        "This pull request has no review comments.",
      );
    return {
      headSha,
      ...pullRequestFixSubject(task, { failures, comments }),
    };
  }

  async commitStatus(
    actor: CloudActor,
    id: string,
    headSha: string,
    status: GitCommitStatus,
  ): Promise<void> {
    const visible = await this.database.transaction((sql) =>
      this.visible(sql, actor, id),
    );
    await gitClient(visible.connection, this.transport).commitStatus(
      visible.pullRequest.repository,
      headSha,
      status,
    );
  }

  async mergeBase(
    actor: CloudActor,
    id: string,
  ): Promise<{ ref: string; sha: string; mergeBase: string }> {
    const visible = await this.database.transaction((sql) =>
      this.visible(sql, actor, id),
    );
    const { repository, baseRef, headSha } = visible.pullRequest;
    const resolved = await gitClient(
      visible.connection,
      this.transport,
    ).mergeBase(repository, baseRef, headSha);
    return {
      ref: baseRef,
      sha: resolved.baseSha,
      mergeBase: resolved.mergeBase,
    };
  }

  async files(actor: CloudActor, id: string): Promise<GitPullRequestFile[]> {
    const visible = await this.database.transaction((sql) =>
      this.visible(sql, actor, id),
    );
    return gitClient(visible.connection, this.transport).files(
      visible.pullRequest.repository,
      visible.pullRequest.number,
    );
  }

  private async act<T>(
    visible: WritablePullRequest,
    operation: (acting: ActingAccess) => Promise<T>,
  ): Promise<ActingAccess & { result: T }> {
    try {
      return { ...visible.acting, result: await operation(visible.acting) };
    } catch (error) {
      if (!isCloudError(error) || error.code !== "git_token") throw error;
      throw await this.identities.rejected(visible.connection, visible.userId);
    }
  }

  private async restore(
    visible: WritablePullRequest,
    acting: ActingAccess,
  ): Promise<void> {
    await this.sync.store(
      visible.connection,
      visible.repository,
      await gitClient(visible.connection, this.transport).pullRequest(
        visible.pullRequest.repository,
        visible.pullRequest.number,
      ),
      { sender: acting.login },
    );
  }

  async merge(
    actor: CloudActor,
    id: string,
    input: GitMergeInput,
  ): Promise<CloudPullRequest> {
    const visible = await this.writable(actor, id);
    const { repository, number } = visible.pullRequest;
    const acting = await this.act(visible, (access) =>
      gitClient(access, this.transport).merge(repository, number, input),
    );
    await this.restore(visible, acting);
    return this.get(actor, id);
  }

  async close(actor: CloudActor, id: string): Promise<CloudPullRequest> {
    const visible = await this.writable(actor, id);
    const { repository, number } = visible.pullRequest;
    const acting = await this.act(visible, (access) =>
      gitClient(access, this.transport).closePullRequest(repository, number),
    );
    await this.restore(visible, acting);
    return this.get(actor, id);
  }

  async setAutoMerge(
    actor: CloudActor,
    id: string,
    input: GitAutoMergeInput,
  ): Promise<void> {
    const visible = await this.writable(actor, id);
    const { repository, number } = visible.pullRequest;
    await this.act(visible, (access) =>
      gitClient(access, this.transport).setAutoMerge(
        repository,
        number,
        input.enabled,
        input.method,
      ),
    );
  }

  async updateBranch(
    actor: CloudActor,
    id: string,
    headSha: string,
  ): Promise<void> {
    const visible = await this.writable(actor, id);
    await this.act(visible, (access) =>
      gitClient(access, this.transport).updateBranch(
        visible.pullRequest.repository,
        visible.pullRequest.number,
        headSha,
      ),
    );
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_git_pull_requests SET signals_synced_at=NULL WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      ),
    );
  }

  async retarget(
    actor: CloudActor,
    id: string,
    baseRef: string,
  ): Promise<CloudPullRequest> {
    const visible = await this.writable(actor, id);
    if (visible.pullRequest.baseRef === baseRef) return visible.pullRequest;
    const acting = await this.act(visible, (access) =>
      gitClient(access, this.transport).retarget(
        visible.pullRequest.repository,
        visible.pullRequest.number,
        baseRef,
      ),
    );
    await this.restore(visible, acting);
    return this.get(actor, id);
  }

  async comment(
    actor: CloudActor,
    id: string,
    body: string,
  ): Promise<{ url: string; actingAs: string }> {
    const visible = await this.writable(actor, id);
    const acting = await this.act(visible, (access) =>
      gitClient(access, this.transport).comment(
        visible.pullRequest.repository,
        visible.pullRequest.number,
        body,
      ),
    );
    return { url: acting.result, actingAs: acting.login };
  }

  async review(
    actor: CloudActor,
    id: string,
    input: { decision: GitReviewInput; body: string },
  ): Promise<{ actingAs: string }> {
    const visible = await this.writable(actor, id);
    const { pullRequest } = visible;
    const acting = await this.act(visible, (access) => {
      const body = input.body;
      return gitClient(access, this.transport).review(
        pullRequest.repository,
        pullRequest.number,
        {
          decision: input.decision,
          body: body ? `${body}\n\n${automationMarker}` : automationMarker,
          headSha: pullRequest.headSha,
        },
      );
    });
    const event = reviewEvents[input.decision];
    await this.database.transaction(async (sql) => {
      await sql.query(
        "UPDATE cloud_git_pull_requests SET signals_synced_at=NULL WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
      if (input.decision !== "comment" || input.body)
        await queueGitEvents(sql, visible.connection, [
          gitEvent(visible.repository, event.kind, {
            branch: pullRequest.baseRef,
            sender: acting.login,
            pullRequest: eventPullRequest(pullRequest.id, pullRequest),
            review: {
              state: event.state,
              body: input.body,
              author: acting.login,
            },
            issueIds: visible.issues.map((issue) => issue.id),
          }),
        ]);
    });
    return { actingAs: acting.login };
  }
}
