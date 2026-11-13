import { randomUUID } from "node:crypto";
import {
  automationTarget,
  pullRequestAutomationEvent,
  pullRequestStage,
  reviewDecision,
  type AutomationStatus,
  type GitStatusEvent,
  type GitChecksState,
  type GitReviewDecision,
  type PullRequestStage,
  type PullRequestState,
} from "../../../lib/git-automation";
import {
  pullRequestLifecycleEvents,
  type GitEvent,
  type GitEventPullRequest,
} from "../../../lib/git-events";
import { pullRequestReferences } from "../../../lib/git-links";
import type { GitProvider } from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, isCloudError } from "../access";
import { derivedCommandId } from "../command-ids";
import type { CloudDatabase, CloudSql } from "../database";
import type { CloudIssueChanges } from "../issue-changes";
import { queueAutomationEvents } from "../automation/automation-events";
import { gitClient, type GitPullRequestRecord } from "./git-client";
import {
  currentHookVersion,
  gitConnection,
  type GitConnectionRecord,
} from "./connections";
import { gitEvent, queueGitEvents, type StoredRepository } from "./events";

const syncIntervalMinutes = 5;
const pendingChecksIntervalMinutes = 2;
const deliveryRetentionDays = 7;

export const repositoryColumns = `r.id,r.provider,r.full_name AS "fullName",r.default_branch AS "defaultBranch",r.web_url AS "webUrl"`;

export interface PullRequestSignalsUpdate {
  checks: GitChecksState;
  review: GitReviewDecision;
}

export interface StoreOptions {
  signals?: PullRequestSignalsUpdate;
  emit?: boolean;
  sender?: string | null;
}

export type SyncConnection = Pick<
  GitConnectionRecord,
  "organizationId" | "actorId" | "automate" | "provider" | "apiUrl"
>;

type StoredPullRequest = {
  id: string;
  state: PullRequestState;
  draft: boolean;
  head_sha: string;
  mergeable_state: string | null;
  checks: GitChecksState | null;
  review: GitReviewDecision | null;
  stage: PullRequestStage;
  updated_at: Date;
  signals_synced_at: Date | null;
};

type LinkedIssue = {
  id: string;
  identifier: string;
  team_id: string;
  status_id: string;
  category: AutomationStatus["category"];
  position: number;
};

type TeamStatus = AutomationStatus & { team_id: string; revision: number };

interface AutomationStep {
  issueId: string;
  status: { id: string; revision: number };
  key: string;
}

async function automationSteps(
  sql: CloudSql,
  organizationId: string,
  pullRequestId: string,
  event: GitStatusEvent | null,
  issues: (LinkedIssue & { completes: boolean })[],
): Promise<AutomationStep[]> {
  if (!event || !issues.length) return [];
  const teamIds = [...new Set(issues.map((issue) => issue.team_id))];
  const statuses = (
    await sql.query<TeamStatus & Record<string, unknown>>(
      "SELECT id,team_id,category,position,archived,revision FROM cloud_workflow_statuses WHERE organization_id=$1 AND team_id=ANY($2::uuid[])",
      [organizationId, teamIds],
    )
  ).rows;
  const rules = new Map(
    (
      await sql.query<{ team_id: string; status_id: string | null }>(
        "SELECT team_id,status_id FROM cloud_git_status_rules WHERE organization_id=$1 AND team_id=ANY($2::uuid[]) AND event=$3",
        [organizationId, teamIds, event],
      )
    ).rows.map((row) => [row.team_id, row.status_id]),
  );
  return issues.flatMap((issue) => {
    if (event === "merged" && !issue.completes) return [];
    const team = statuses.filter((status) => status.team_id === issue.team_id);
    const target = automationTarget(event, rules.get(issue.team_id), team, {
      id: issue.status_id,
      category: issue.category,
      position: issue.position,
      archived: false,
    }) as TeamStatus | null;
    return target
      ? [
          {
            issueId: issue.id,
            status: { id: target.id, revision: target.revision },
            key: derivedCommandId(
              `${pullRequestId}:${event}`,
              `git-status:${issue.id}`,
            ),
          },
        ]
      : [];
  });
}

export function eventPullRequest(
  id: string,
  pullRequest: Pick<
    GitPullRequestRecord,
    | "number"
    | "title"
    | "url"
    | "author"
    | "headRef"
    | "baseRef"
    | "headSha"
    | "draft"
  >,
): GitEventPullRequest {
  return {
    id,
    number: pullRequest.number,
    title: pullRequest.title.slice(0, 300),
    url: pullRequest.url.slice(0, 500),
    author: pullRequest.author,
    headRef: pullRequest.headRef,
    baseRef: pullRequest.baseRef,
    headSha: pullRequest.headSha,
    draft: pullRequest.draft,
  };
}

async function stackChildren(
  sql: CloudSql,
  organizationId: string,
  repository: StoredRepository,
  parent: GitPullRequestRecord,
  sender: string | null,
): Promise<GitEvent[]> {
  const children = (
    await sql.query<{
      id: string;
      number: number;
      title: string;
      url: string;
      author: string | null;
      headRef: string;
      baseRef: string;
      headSha: string;
      draft: boolean;
      issueIds: string[];
    }>(
      `SELECT p.id,p.number,p.title,p.url,p.author,p.head_ref AS "headRef",p.base_ref AS "baseRef",p.head_sha AS "headSha",p.draft,
      COALESCE((SELECT array_agg(l.issue_id) FROM cloud_git_pull_request_issues l WHERE l.organization_id=p.organization_id AND l.pull_request_id=p.id),'{}') AS "issueIds"
      FROM cloud_git_pull_requests p WHERE p.organization_id=$1 AND p.repository_id=$2 AND p.base_ref=$3 AND p.state='open'`,
      [organizationId, repository.id, parent.headRef],
    )
  ).rows;
  return children.map((child) =>
    gitEvent(repository, "stack_base_merged", {
      branch: child.baseRef,
      sender,
      pullRequest: eventPullRequest(child.id, child),
      parent: {
        number: parent.number,
        title: parent.title.slice(0, 300),
        headRef: parent.headRef,
        baseRef: parent.baseRef,
      },
      issueIds: child.issueIds,
    }),
  );
}

export class CloudGitSync {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly issueChanges: CloudIssueChanges,
    private readonly transport: typeof fetch,
    private readonly webhookUrl: (provider: GitProvider, id: string) => string,
    private readonly secureOrigin: boolean,
  ) {}

  async store(
    connection: SyncConnection,
    repository: StoredRepository,
    pullRequest: GitPullRequestRecord,
    options: StoreOptions = {},
  ): Promise<string> {
    const { signals, emit = true } = options;
    const state = pullRequest.state;
    const draft = pullRequest.draft;
    const { id, steps } = await this.database.transaction(async (sql) => {
      const organizationId = connection.organizationId;
      const previous = (
        await sql.query<StoredPullRequest>(
          `SELECT id,state,draft,head_sha,mergeable_state,checks,review,stage,updated_at,signals_synced_at
          FROM cloud_git_pull_requests WHERE organization_id=$1 AND repository_id=$2 AND number=$3 FOR UPDATE`,
          [organizationId, repository.id, pullRequest.number],
        )
      ).rows[0];
      const id = previous?.id ?? randomUUID();
      const headChanged = previous?.head_sha !== pullRequest.headSha;
      const changed =
        !previous ||
        headChanged ||
        previous.state !== state ||
        previous.updated_at.getTime() !== Date.parse(pullRequest.updatedAt);
      const checks =
        signals?.checks ?? (headChanged ? null : (previous?.checks ?? null));
      const review = signals?.review ?? previous?.review ?? null;
      const mergeableState =
        pullRequest.mergeableState ??
        (headChanged ? null : (previous?.mergeable_state ?? null));
      const stage = pullRequestStage({
        state,
        draft,
        mergeableState,
        checks,
        review,
      });
      const signalsSyncedAt = signals
        ? new Date()
        : state === "open" && changed
          ? null
          : (previous?.signals_synced_at ?? null);
      await sql.query(
        `INSERT INTO cloud_git_pull_requests (organization_id,id,repository_id,number,title,url,state,draft,author,head_ref,head_sha,base_ref,
          mergeable_state,additions,deletions,changed_files,checks,review,stage,merged_at,updated_at,signals_synced_at,requested_reviewers)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::integer,0),COALESCE($15::integer,0),COALESCE($16::integer,0),$17,$18,$19,$20,$21,$22,COALESCE($23::text[],'{}'))
        ON CONFLICT (organization_id,repository_id,number) DO UPDATE SET title=$5,url=$6,state=$7,draft=$8,author=COALESCE($9,cloud_git_pull_requests.author),
        head_ref=$10,head_sha=$11,base_ref=$12,mergeable_state=$13,additions=COALESCE($14::integer,cloud_git_pull_requests.additions),
        deletions=COALESCE($15::integer,cloud_git_pull_requests.deletions),changed_files=COALESCE($16::integer,cloud_git_pull_requests.changed_files),
        checks=$17,review=$18,stage=$19,merged_at=$20,updated_at=$21,signals_synced_at=$22,
        requested_reviewers=COALESCE($23::text[],cloud_git_pull_requests.requested_reviewers),synced_at=clock_timestamp()`,
        [
          organizationId,
          id,
          repository.id,
          pullRequest.number,
          pullRequest.title.slice(0, 1000),
          pullRequest.url.slice(0, 500),
          state,
          draft,
          pullRequest.author?.slice(0, 100) ?? null,
          pullRequest.headRef.slice(0, 255),
          pullRequest.headSha,
          pullRequest.baseRef.slice(0, 255),
          mergeableState?.slice(0, 40) ?? null,
          pullRequest.additions,
          pullRequest.deletions,
          pullRequest.changedFiles,
          checks,
          review,
          stage,
          pullRequest.mergedAt,
          pullRequest.updatedAt,
          signalsSyncedAt,
          pullRequest.requestedReviewers
            ?.slice(0, 50)
            .map((login) => login.slice(0, 100)) ?? null,
        ],
      );
      const keys = (
        await sql.query<{ key: string }>(
          "SELECT key FROM cloud_teams WHERE organization_id=$1",
          [organizationId],
        )
      ).rows.map((row) => row.key);
      const references = pullRequestReferences(
        {
          branch: pullRequest.headRef,
          title: pullRequest.title,
          body: pullRequest.body,
        },
        keys,
      );
      const intoDefaultBranch =
        pullRequest.baseRef === repository.defaultBranch;
      const issues = references.length
        ? (
            await sql.query<LinkedIssue>(
              `SELECT i.id,i.identifier,i.team_id,s.id AS status_id,s.category,s.position FROM cloud_issues i
              JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
              WHERE i.organization_id=$1 AND i.identifier=ANY($2::text[])`,
              [organizationId, references.map((entry) => entry.identifier)],
            )
          ).rows.map((issue) => {
            const closes = references.some(
              (entry) => entry.identifier === issue.identifier && entry.closes,
            );
            return { ...issue, closes, completes: closes && intoDefaultBranch };
          })
        : [];
      await sql.query(
        "DELETE FROM cloud_git_pull_request_issues WHERE organization_id=$1 AND pull_request_id=$2",
        [organizationId, id],
      );
      for (const issue of issues)
        await sql.query(
          "INSERT INTO cloud_git_pull_request_issues (organization_id,pull_request_id,issue_id,closes) VALUES ($1,$2,$3,$4)",
          [organizationId, id, issue.id, issue.closes],
        );
      if (emit && previous?.stage !== stage)
        for (const issue of issues)
          await queueAutomationEvents(sql, {
            organizationId,
            teamId: issue.team_id,
            issueId: issue.id,
            actorId: null,
            events: [
              {
                kind: "pull_request_changed",
                pullRequestId: id,
                stage,
                title: pullRequest.title.slice(0, 300),
                url: pullRequest.url.slice(0, 500),
              },
            ],
          });
      if (emit) {
        const kinds = pullRequestLifecycleEvents(
          previous
            ? {
                state: previous.state,
                draft: previous.draft,
                headSha: previous.head_sha,
                checks: previous.checks,
              }
            : null,
          { state, draft, headSha: pullRequest.headSha, checks },
        );
        const event = eventPullRequest(id, pullRequest);
        const issueIds = issues.map((issue) => issue.id);
        const events = kinds.map((kind) =>
          gitEvent(repository, kind, {
            branch: pullRequest.baseRef,
            sender:
              options.sender ??
              (kind === "pull_request_opened" ? pullRequest.author : null),
            pullRequest: event,
            issueIds,
          }),
        );
        if (kinds.includes("pull_request_merged"))
          events.push(
            ...(await stackChildren(
              sql,
              organizationId,
              repository,
              pullRequest,
              options.sender ?? null,
            )),
          );
        await queueGitEvents(sql, connection, events);
      }
      const statusEvent = pullRequestAutomationEvent(
        { state, draft, review },
        true,
      );
      const previousEvent =
        previous && pullRequestAutomationEvent(previous, true);
      return {
        id,
        steps:
          emit && connection.automate && statusEvent !== previousEvent
            ? await automationSteps(
                sql,
                organizationId,
                id,
                statusEvent,
                issues,
              )
            : [],
      };
    });
    for (const step of steps) {
      try {
        await this.issueChanges.apply(
          {
            organizationId: connection.organizationId,
            userId: connection.actorId,
          },
          step.key,
          { issues: [{ id: step.issueId }], changes: { status: step.status } },
        );
      } catch (error) {
        if (!isCloudError(error)) throw error;
        await this.recordError(connection, error.message);
      }
    }
    return id;
  }

  async refresh(
    connection: GitConnectionRecord,
    repository: StoredRepository,
    number: number,
  ): Promise<void> {
    const client = gitClient(connection, this.transport);
    const [pullRequest, reviews] = await Promise.all([
      client.pullRequest(repository.fullName, number),
      client.reviews(repository.fullName, number),
    ]);
    const checks = await client.checks(
      repository.fullName,
      number,
      pullRequest.headSha,
    );
    await this.store(connection, repository, pullRequest, {
      signals: {
        checks: checks.conclusion,
        review: reviewDecision(reviews.map((review) => review.state)),
      },
    });
  }

  private async recordError(
    connection: Pick<SyncConnection, "organizationId" | "provider">,
    message: string | null,
  ) {
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_git_connections SET last_error=$3 WHERE organization_id=$1 AND provider=$2",
        [
          connection.organizationId,
          connection.provider,
          message?.slice(0, 500) ?? null,
        ],
      ),
    );
  }

  private claimConnection(): Promise<{
    connection: GitConnectionRecord;
    repositories: (StoredRepository & { syncedAt: Date | null })[];
  } | null> {
    return this.database.transaction(async (sql) => {
      await sql.query(
        `DELETE FROM cloud_git_deliveries WHERE received_at < clock_timestamp() - interval '${deliveryRetentionDays} days'`,
      );
      const due = (
        await sql.query<{ organization_id: string; provider: GitProvider }>(
          `SELECT organization_id,provider FROM cloud_git_connections
          WHERE sync_requested_at IS NOT NULL OR synced_at IS NULL OR synced_at < clock_timestamp() - interval '${syncIntervalMinutes} minutes'
          ORDER BY sync_requested_at NULLS LAST, synced_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!due) return null;
      await sql.query(
        "UPDATE cloud_git_connections SET synced_at=clock_timestamp(),sync_requested_at=NULL WHERE organization_id=$1 AND provider=$2",
        [due.organization_id, due.provider],
      );
      return {
        connection: await gitConnection(
          sql,
          this.cipher,
          due.organization_id,
          due.provider,
        ),
        repositories: (
          await sql.query<StoredRepository & { syncedAt: Date | null }>(
            `SELECT ${repositoryColumns},r.synced_at AS "syncedAt" FROM cloud_git_repositories r WHERE r.organization_id=$1 AND r.provider=$2`,
            [due.organization_id, due.provider],
          )
        ).rows,
      };
    });
  }

  private async syncConnection(): Promise<number> {
    const claimed = await this.claimConnection();
    if (!claimed) return 0;
    const { connection, repositories } = claimed;
    const client = gitClient(connection, this.transport);
    let failure: string | null = null;
    for (const repository of repositories) {
      try {
        const started = new Date();
        for (const pullRequest of await client.pullRequests(
          repository.fullName,
        )) {
          if (
            repository.syncedAt &&
            Date.parse(pullRequest.updatedAt) < repository.syncedAt.getTime()
          )
            break;
          await this.store(connection, repository, pullRequest, {
            emit: repository.syncedAt !== null,
          });
        }
        await this.database.transaction((sql) =>
          sql.query(
            "UPDATE cloud_git_repositories SET synced_at=$3 WHERE organization_id=$1 AND id=$2",
            [connection.organizationId, repository.id, started],
          ),
        );
      } catch (error) {
        if (!isCloudError(error)) throw error;
        failure = `${repository.fullName}: ${error.message}`;
      }
    }
    await this.recordError(connection, failure);
    return 1;
  }

  private async refreshStale(): Promise<number> {
    const stale = await this.database.transaction(async (sql) => {
      const row = (
        await sql.query<
          StoredRepository & {
            organizationId: string;
            pullRequestId: string;
            number: number;
          }
        >(
          `SELECT p.organization_id AS "organizationId",p.id AS "pullRequestId",p.number,${repositoryColumns} FROM cloud_git_pull_requests p
          JOIN cloud_git_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
          WHERE p.state='open' AND (p.signals_synced_at IS NULL OR (p.checks='pending' AND r.hook_id IS NULL
            AND p.signals_synced_at < clock_timestamp() - interval '${pendingChecksIntervalMinutes} minutes'))
          ORDER BY p.signals_synced_at NULLS FIRST LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return null;
      await sql.query(
        "UPDATE cloud_git_pull_requests SET signals_synced_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [row.organizationId, row.pullRequestId],
      );
      return {
        row,
        connection: await gitConnection(
          sql,
          this.cipher,
          row.organizationId,
          row.provider,
        ),
      };
    });
    if (!stale) return 0;
    const { row, connection } = stale;
    try {
      await this.refresh(connection, row, row.number);
    } catch (error) {
      if (!isCloudError(error)) throw error;
      await this.recordError(
        connection,
        `${row.fullName}#${row.number}: ${error.message}`,
      );
    }
    return 1;
  }

  private async upgradeRepository(): Promise<number> {
    const claimed = await this.database.transaction(async (sql) => {
      const row = (
        await sql.query<
          StoredRepository & { organizationId: string; hookId: string | null }
        >(
          `SELECT r.organization_id AS "organizationId",r.hook_id AS "hookId",${repositoryColumns} FROM cloud_git_repositories r
          WHERE r.hook_version < $1 ORDER BY r.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [currentHookVersion],
        )
      ).rows[0];
      if (!row) return null;
      await sql.query(
        "UPDATE cloud_git_repositories SET hook_version=$3 WHERE organization_id=$1 AND id=$2",
        [row.organizationId, row.id, currentHookVersion],
      );
      return {
        row,
        connection: await gitConnection(
          sql,
          this.cipher,
          row.organizationId,
          row.provider,
        ),
      };
    });
    if (!claimed) return 0;
    const { row, connection } = claimed;
    const client = gitClient(connection, this.transport);
    try {
      const repository = await client.repository(row.fullName);
      let hookGone = false;
      if (row.hookId && this.secureOrigin)
        await client
          .updateWebhook(row.fullName, Number(row.hookId), {
            url: this.webhookUrl(row.provider, connection.webhookId),
            secret: connection.webhookSecret,
          })
          .catch((error: unknown) => {
            if (!(error instanceof CloudError && error.status === 404))
              throw error;
            hookGone = true;
          });
      await this.database.transaction((sql) =>
        sql.query(
          `UPDATE cloud_git_repositories SET default_branch=$3,web_url=$4,private=$5,hook_id=CASE WHEN $6 THEN NULL ELSE hook_id END
          WHERE organization_id=$1 AND id=$2`,
          [
            row.organizationId,
            row.id,
            repository.defaultBranch,
            repository.webUrl.slice(0, 500),
            repository.private,
            hookGone,
          ],
        ),
      );
    } catch (error) {
      if (!isCloudError(error)) throw error;
      await this.recordError(connection, `${row.fullName}: ${error.message}`);
    }
    return 1;
  }

  async tick(): Promise<number> {
    if (!this.cipher) return 0;
    return (
      (await this.syncConnection()) +
      (await this.refreshStale()) +
      (await this.upgradeRepository())
    );
  }
}
