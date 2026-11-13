import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudLinkedIssue,
  CloudPullRequest,
  CloudPullRequestDetails,
  CloudPullRequestList,
  CloudReviewInbox,
  GitMergeInput,
  GitPullRequestFile,
  GitReviewInput,
} from "../../../lib/cloud-git-contract";
import {
  pullRequestStages,
  reviewDecision,
  type PullRequestStage,
} from "../../../lib/git-automation";
import { pullRequestStacks } from "../../../lib/pull-request-stacks";
import type { SettingsCipher } from "../../settings-crypto";
import {
  accessCan,
  CloudError,
  requireMembership,
  teamVisibility,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { readIssue } from "../planning";
import { gitClient } from "./git-client";
import { gitConnection, type GitConnectionRecord } from "./connections";
import type { StoredRepository } from "./events";
import type { ActingAccess, ActingMode, GitIdentities } from "./identity";
import type { CloudGitSync } from "./sync";
import type { GitProvider } from "../../../lib/git-providers";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const recentDays = 14;
const stackDays = 30;
const listLimit = 300;
const pullRequestColumns = `p.id,r.provider,r.full_name AS repository,p.number,p.title,p.url,p.state,p.draft,p.author,p.head_ref AS "headRef",p.head_sha AS "headSha",
  p.base_ref AS "baseRef",r.default_branch AS "defaultBranch",p.mergeable_state AS "mergeableState",p.additions,p.deletions,p.changed_files AS "changedFiles",
  p.checks,p.review,p.stage,to_char(p.merged_at AT TIME ZONE 'UTC',${timestamp}) AS "mergedAt",
  to_char(p.updated_at AT TIME ZONE 'UTC',${timestamp}) AS "updatedAt",p.repository_id AS "repositoryId",
  r.web_url AS "repositoryUrl",p.requested_reviewers AS "requestedReviewers",COALESCE(v.closes,false) AS closes,COALESCE(v.issues,'[]'::jsonb) AS issues`;
const stageOrder = `CASE p.stage ${pullRequestStages.map((stage, index) => `WHEN '${stage}' THEN ${index}`).join(" ")} END`;
const visibleCte = `WITH visible AS (
    SELECT l.pull_request_id,bool_or(l.closes) AS closes,
    jsonb_agg(jsonb_build_object('id',i.id,'identifier',i.identifier,'title',i.title,'statusName',s.name,'state',i.state) ORDER BY i.identifier) AS issues
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
  repositoryUrl: string | null;
  issues: CloudLinkedIssue[];
};

interface VisiblePullRequest {
  pullRequest: CloudPullRequest;
  issues: CloudLinkedIssue[];
  repository: StoredRepository;
  connection: GitConnectionRecord;
  canAct: boolean;
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
    repositoryId?: unknown;
    repositoryUrl?: unknown;
  },
): CloudPullRequest {
  const {
    issues: _issues,
    repositoryId: _repository,
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
        provider: row.provider,
        fullName: row.repository,
        defaultBranch: row.defaultBranch,
        webUrl: row.repositoryUrl,
      },
      connection: await gitConnection(
        sql,
        this.cipher,
        actor.organizationId,
        row.provider,
      ),
      canAct: accessCan(access, "git.act"),
    };
  }

  get(actor: CloudActor, id: string): Promise<CloudPullRequest> {
    return this.database.transaction(
      async (sql) => (await this.visible(sql, actor, id)).pullRequest,
    );
  }

  private async writable(
    actor: CloudActor,
    id: string,
    mode: ActingMode,
  ): Promise<VisiblePullRequest & { acting: ActingAccess }> {
    if (mode !== "organization")
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
          mode,
        ),
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
    const { updated, actingAs } = await this.database.transaction(
      async (sql) => {
        const current = await this.visible(sql, actor, id);
        return {
          updated: current,
          actingAs: await this.identities.actingLogin(
            sql,
            current.connection,
            actor.userId,
          ),
        };
      },
    );
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
      canMerge: updated.canAct && updated.pullRequest.state === "open",
      actingAs,
      mergeMethods: [...client.mergeMethods],
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

  private async restore(
    visible: VisiblePullRequest & { acting: ActingAccess },
  ): Promise<void> {
    await this.sync.store(
      visible.connection,
      visible.repository,
      await gitClient(visible.connection, this.transport).pullRequest(
        visible.pullRequest.repository,
        visible.pullRequest.number,
      ),
      { sender: visible.acting.login },
    );
  }

  async merge(
    actor: CloudActor,
    id: string,
    input: GitMergeInput,
    mode: ActingMode = "personal_first",
  ): Promise<CloudPullRequest> {
    const visible = await this.writable(actor, id, mode);
    const { repository, number } = visible.pullRequest;
    await gitClient(visible.acting, this.transport).merge(
      repository,
      number,
      input,
    );
    await this.restore(visible);
    return this.get(actor, id);
  }

  async updateBranch(
    actor: CloudActor,
    id: string,
    headSha: string,
    mode: ActingMode = "personal_first",
  ): Promise<void> {
    const visible = await this.writable(actor, id, mode);
    await gitClient(visible.acting, this.transport).updateBranch(
      visible.pullRequest.repository,
      visible.pullRequest.number,
      headSha,
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
    mode: ActingMode = "personal_first",
  ): Promise<CloudPullRequest> {
    const visible = await this.writable(actor, id, mode);
    if (visible.pullRequest.baseRef === baseRef) return visible.pullRequest;
    await gitClient(visible.acting, this.transport).retarget(
      visible.pullRequest.repository,
      visible.pullRequest.number,
      baseRef,
    );
    await this.restore(visible);
    return this.get(actor, id);
  }

  async comment(
    actor: CloudActor,
    id: string,
    body: string,
    mode: ActingMode = "personal_first",
  ): Promise<{ url: string; actingAs: string }> {
    const visible = await this.writable(actor, id, mode);
    return {
      url: await gitClient(visible.acting, this.transport).comment(
        visible.pullRequest.repository,
        visible.pullRequest.number,
        body,
      ),
      actingAs: visible.acting.login,
    };
  }

  async review(
    actor: CloudActor,
    id: string,
    input: { decision: GitReviewInput; body: string },
    mode: ActingMode = "personal_first",
  ): Promise<{ actingAs: string }> {
    const visible = await this.writable(actor, id, mode);
    await gitClient(visible.acting, this.transport).review(
      visible.pullRequest.repository,
      visible.pullRequest.number,
      { ...input, headSha: visible.pullRequest.headSha },
    );
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_git_pull_requests SET signals_synced_at=NULL WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      ),
    );
    return { actingAs: visible.acting.login };
  }
}
