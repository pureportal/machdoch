import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudLinkedIssue,
  CloudPullRequest,
  CloudPullRequestDetails,
  CloudPullRequestList,
  CloudPullRequestListing,
  GitHubMergeInput,
  GitHubPullRequestFile,
} from "../../../lib/cloud-github-contract";
import {
  pullRequestStages,
  reviewDecision,
  type PullRequestStage,
} from "../../../lib/github-automation";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, requireMembership, teamVisibility } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { readIssue } from "../planning";
import { GitHubClient } from "./client";
import { githubConnection, type GitHubConnectionRecord } from "./connections";
import type { CloudGitHubSync } from "./sync";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const recentDays = 14;
const listLimit = 300;
const pullRequestColumns = `p.id,r.full_name AS repository,p.number,p.title,p.url,p.state,p.draft,p.author,p.head_ref AS "headRef",p.head_sha AS "headSha",
  p.base_ref AS "baseRef",p.mergeable_state AS "mergeableState",p.additions,p.deletions,p.changed_files AS "changedFiles",p.checks,p.review,p.stage,
  to_char(p.merged_at AT TIME ZONE 'UTC',${timestamp}) AS "mergedAt",to_char(p.updated_at AT TIME ZONE 'UTC',${timestamp}) AS "updatedAt"`;
const stageOrder = `CASE p.stage ${pullRequestStages.map((stage, index) => `WHEN '${stage}' THEN ${index}`).join(" ")} END`;
const visibleIssueJoins = `JOIN cloud_issues i ON i.organization_id=l.organization_id AND i.id=l.issue_id
  JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
  JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
  JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2`;
const linkedIssueColumns = `jsonb_agg(jsonb_build_object('id',i.id,'identifier',i.identifier,'title',i.title,'statusName',s.name,'state',i.state) ORDER BY i.identifier)`;

interface VisiblePullRequest {
  pullRequest: CloudPullRequest;
  issues: CloudLinkedIssue[];
  repositoryId: string;
  connection: GitHubConnectionRecord;
  canMerge: boolean;
}

export class CloudGitHubPullRequests {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly sync: CloudGitHubSync,
    private readonly transport: typeof fetch,
  ) {}

  forIssue(actor: CloudActor, issueId: string): Promise<CloudPullRequest[]> {
    return this.database.transaction(async (sql) => {
      await readIssue(sql, actor, issueId);
      return (
        await sql.query<CloudPullRequest & Record<string, unknown>>(
          `SELECT ${pullRequestColumns},l.closes FROM cloud_github_pull_request_issues l
          JOIN cloud_github_pull_requests p ON p.organization_id=l.organization_id AND p.id=l.pull_request_id
          JOIN cloud_github_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
          WHERE l.organization_id=$1 AND l.issue_id=$2
          ORDER BY ${stageOrder},p.updated_at DESC`,
          [actor.organizationId, issueId],
        )
      ).rows;
    });
  }

  list(
    actor: CloudActor,
    stage: PullRequestStage | undefined,
  ): Promise<CloudPullRequestList> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const rows = (
        await sql.query<
          CloudPullRequest & { issues: CloudLinkedIssue[] } & Record<
              string,
              unknown
            >
        >(
          `WITH visible AS (
            SELECT l.pull_request_id,bool_or(l.closes) AS closes,${linkedIssueColumns} AS issues
            FROM cloud_github_pull_request_issues l ${visibleIssueJoins}
            WHERE l.organization_id=$1 AND NOT i.archived AND ${teamVisibility}
            GROUP BY l.pull_request_id
          )
          SELECT ${pullRequestColumns},v.closes,v.issues FROM visible v
          JOIN cloud_github_pull_requests p ON p.organization_id=$1 AND p.id=v.pull_request_id
          JOIN cloud_github_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
          WHERE p.state='open' OR p.updated_at > clock_timestamp() - interval '${recentDays} days'
          ORDER BY ${stageOrder},p.updated_at DESC LIMIT ${listLimit}`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
      const counts = Object.fromEntries(
        pullRequestStages.map((entry) => [
          entry,
          rows.filter((row) => row.stage === entry).length,
        ]),
      ) as Record<PullRequestStage, number>;
      const connected = await sql.query(
        "SELECT 1 FROM cloud_github_connections WHERE organization_id=$1",
        [actor.organizationId],
      );
      return {
        connected: connected.rows.length > 0,
        counts,
        pullRequests: rows
          .filter((row) => !stage || row.stage === stage)
          .map(
            ({ issues, ...pullRequest }): CloudPullRequestListing => ({
              pullRequest,
              issues,
            }),
          ),
      };
    });
  }

  private async visible(
    sql: CloudSql,
    actor: CloudActor,
    id: string,
  ): Promise<VisiblePullRequest> {
    const role = await requireMembership(sql, actor);
    const row = (
      await sql.query<
        CloudPullRequest & {
          repositoryId: string;
          issues: CloudLinkedIssue[];
        } & Record<string, unknown>
      >(
        `SELECT ${pullRequestColumns},bool_or(l.closes) AS closes,p.repository_id AS "repositoryId",${linkedIssueColumns} AS issues
        FROM cloud_github_pull_requests p
        JOIN cloud_github_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
        JOIN cloud_github_pull_request_issues l ON l.organization_id=p.organization_id AND l.pull_request_id=p.id
        ${visibleIssueJoins}
        WHERE p.organization_id=$1 AND p.id=$3 AND ${teamVisibility}
        GROUP BY p.organization_id,p.id,r.full_name`,
        [actor.organizationId, actor.userId, id],
      )
    ).rows[0];
    if (!row)
      throw new CloudError(404, "not_found", "Pull request is unavailable.");
    const { repositoryId, issues, ...pullRequest } = row;
    return {
      pullRequest,
      issues,
      repositoryId,
      connection: await githubConnection(
        sql,
        this.cipher,
        actor.organizationId,
      ),
      canMerge: role !== "viewer",
    };
  }

  private async writable(
    actor: CloudActor,
    id: string,
  ): Promise<VisiblePullRequest> {
    const visible = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      return this.visible(sql, actor, id);
    });
    if (visible.pullRequest.state !== "open")
      throw new CloudError(
        409,
        "github_closed",
        "This pull request is closed.",
      );
    return visible;
  }

  async details(
    actor: CloudActor,
    id: string,
  ): Promise<CloudPullRequestDetails> {
    const visible = await this.database.transaction((sql) =>
      this.visible(sql, actor, id),
    );
    const client = new GitHubClient(visible.connection, this.transport);
    const { repository, number } = visible.pullRequest;
    const [fresh, reviews, comments] = await Promise.all([
      client.pullRequest(repository, number),
      client.reviews(repository, number),
      client.reviewComments(repository, number),
    ]);
    const checks = await client.checks(repository, fresh.head.sha);
    await this.sync.store(visible.connection, visible.repositoryId, fresh, {
      checks: checks.conclusion,
      review: reviewDecision(reviews.map((review) => review.state)),
    });
    const updated = await this.database.transaction((sql) =>
      this.visible(sql, actor, id),
    );
    return {
      pullRequest: updated.pullRequest,
      mergeable: fresh.mergeable ?? null,
      checks,
      reviews,
      comments,
      issues: updated.issues,
      canMerge: updated.canMerge && updated.pullRequest.state === "open",
    };
  }

  async files(actor: CloudActor, id: string): Promise<GitHubPullRequestFile[]> {
    const visible = await this.database.transaction((sql) =>
      this.visible(sql, actor, id),
    );
    return new GitHubClient(visible.connection, this.transport).files(
      visible.pullRequest.repository,
      visible.pullRequest.number,
    );
  }

  async merge(
    actor: CloudActor,
    id: string,
    input: GitHubMergeInput,
  ): Promise<CloudPullRequest> {
    const visible = await this.writable(actor, id);
    const client = new GitHubClient(visible.connection, this.transport);
    const { repository, number } = visible.pullRequest;
    await client.merge(repository, number, input);
    await this.sync.store(
      visible.connection,
      visible.repositoryId,
      await client.pullRequest(repository, number),
    );
    return (
      await this.database.transaction((sql) => this.visible(sql, actor, id))
    ).pullRequest;
  }

  async updateBranch(
    actor: CloudActor,
    id: string,
    headSha: string,
  ): Promise<void> {
    const visible = await this.writable(actor, id);
    await new GitHubClient(visible.connection, this.transport).updateBranch(
      visible.pullRequest.repository,
      visible.pullRequest.number,
      headSha,
    );
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_github_pull_requests SET signals_synced_at=NULL WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      ),
    );
  }
}
