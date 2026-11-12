import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  automationTarget,
  pullRequestAutomationEvent,
  pullRequestStage,
  type AutomationStatus,
  type GitHubAutomationEvent,
  type GitHubChecksState,
  type GitHubReviewDecision,
  type PullRequestState,
} from "../../../lib/github-automation";
import { pullRequestReferences } from "../../../lib/github-links";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, isCloudError } from "../access";
import { derivedCommandId } from "../command-ids";
import type { CloudDatabase, CloudSql } from "../database";
import type { CloudIssueChanges } from "../issue-changes";
import {
  GitHubClient,
  githubPullRequestSchema,
  type GitHubPullRequestRecord,
} from "./client";
import {
  githubConnection,
  githubConnectionByWebhook,
  type GitHubConnectionRecord,
} from "./connections";

const syncIntervalMinutes = 5;
const pendingChecksIntervalMinutes = 2;
const deliveryRetentionDays = 7;

const pullRequestPayloadSchema = z.object({
  repository: z.object({ id: z.number() }),
  pull_request: githubPullRequestSchema,
});
const checkPayloadSchema = z.object({
  repository: z.object({ id: z.number() }),
  check_run: z.object({ head_sha: z.string() }).optional(),
  check_suite: z.object({ head_sha: z.string() }).optional(),
});

export interface PullRequestSignalsUpdate {
  checks: GitHubChecksState;
  review: GitHubReviewDecision;
}

type StoredPullRequest = {
  id: string;
  state: PullRequestState;
  draft: boolean;
  head_sha: string;
  mergeable_state: string | null;
  checks: GitHubChecksState | null;
  review: GitHubReviewDecision | null;
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

type AutomationConnection = Pick<
  GitHubConnectionRecord,
  "organizationId" | "actorId" | "automate"
>;

function pullRequestState(
  pullRequest: GitHubPullRequestRecord,
): PullRequestState {
  return pullRequest.merged_at || pullRequest.merged
    ? "merged"
    : pullRequest.state;
}

async function automationSteps(
  sql: CloudSql,
  organizationId: string,
  pullRequestId: string,
  event: GitHubAutomationEvent | null,
  issues: (LinkedIssue & { closes: boolean })[],
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
        "SELECT team_id,status_id FROM cloud_github_automations WHERE organization_id=$1 AND team_id=ANY($2::uuid[]) AND event=$3",
        [organizationId, teamIds, event],
      )
    ).rows.map((row) => [row.team_id, row.status_id]),
  );
  return issues.flatMap((issue) => {
    const issueEvent = event === "merged" && !issue.closes ? null : event;
    if (!issueEvent) return [];
    const team = statuses.filter((status) => status.team_id === issue.team_id);
    const target = automationTarget(
      issueEvent,
      rules.get(issue.team_id),
      team,
      {
        id: issue.status_id,
        category: issue.category,
        position: issue.position,
        archived: false,
      },
    ) as TeamStatus | null;
    return target
      ? [
          {
            issueId: issue.id,
            status: { id: target.id, revision: target.revision },
            key: derivedCommandId(
              `${pullRequestId}:${issueEvent}`,
              `github-status:${issue.id}`,
            ),
          },
        ]
      : [];
  });
}

export class CloudGitHubSync {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly issueChanges: CloudIssueChanges,
    private readonly transport: typeof fetch,
  ) {}

  async store(
    connection: AutomationConnection,
    repositoryId: string,
    pullRequest: GitHubPullRequestRecord,
    signals?: PullRequestSignalsUpdate,
  ): Promise<string> {
    const state = pullRequestState(pullRequest);
    const draft = pullRequest.draft === true;
    const { id, steps } = await this.database.transaction(async (sql) => {
      const organizationId = connection.organizationId;
      const previous = (
        await sql.query<StoredPullRequest>(
          `SELECT id,state,draft,head_sha,mergeable_state,checks,review,updated_at,signals_synced_at
          FROM cloud_github_pull_requests WHERE organization_id=$1 AND repository_id=$2 AND number=$3 FOR UPDATE`,
          [organizationId, repositoryId, pullRequest.number],
        )
      ).rows[0];
      const id = previous?.id ?? randomUUID();
      const headChanged = previous?.head_sha !== pullRequest.head.sha;
      const changed =
        !previous ||
        headChanged ||
        previous.state !== state ||
        previous.updated_at.getTime() !== Date.parse(pullRequest.updated_at);
      const checks =
        signals?.checks ?? (headChanged ? null : (previous?.checks ?? null));
      const review = signals?.review ?? previous?.review ?? null;
      const mergeableState =
        pullRequest.mergeable_state ??
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
        `INSERT INTO cloud_github_pull_requests (organization_id,id,repository_id,number,title,url,state,draft,author,head_ref,head_sha,base_ref,
          mergeable_state,additions,deletions,changed_files,checks,review,stage,merged_at,updated_at,signals_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::integer,0),COALESCE($15::integer,0),COALESCE($16::integer,0),$17,$18,$19,$20,$21,$22)
        ON CONFLICT (organization_id,repository_id,number) DO UPDATE SET title=$5,url=$6,state=$7,draft=$8,author=$9,head_ref=$10,head_sha=$11,base_ref=$12,
        mergeable_state=$13,additions=COALESCE($14::integer,cloud_github_pull_requests.additions),
        deletions=COALESCE($15::integer,cloud_github_pull_requests.deletions),changed_files=COALESCE($16::integer,cloud_github_pull_requests.changed_files),
        checks=$17,review=$18,stage=$19,merged_at=$20,updated_at=$21,signals_synced_at=$22,synced_at=clock_timestamp()`,
        [
          organizationId,
          id,
          repositoryId,
          pullRequest.number,
          pullRequest.title.slice(0, 1000),
          pullRequest.html_url.slice(0, 500),
          state,
          draft,
          pullRequest.user?.login.slice(0, 100) ?? null,
          pullRequest.head.ref.slice(0, 255),
          pullRequest.head.sha,
          pullRequest.base.ref.slice(0, 255),
          mergeableState?.slice(0, 40) ?? null,
          pullRequest.additions ?? null,
          pullRequest.deletions ?? null,
          pullRequest.changed_files ?? null,
          checks,
          review,
          stage,
          pullRequest.merged_at ?? null,
          pullRequest.updated_at,
          signalsSyncedAt,
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
          branch: pullRequest.head.ref,
          title: pullRequest.title,
          body: pullRequest.body ?? "",
        },
        keys,
      );
      const issues = references.length
        ? (
            await sql.query<LinkedIssue>(
              `SELECT i.id,i.identifier,i.team_id,s.id AS status_id,s.category,s.position FROM cloud_issues i
              JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
              WHERE i.organization_id=$1 AND i.identifier=ANY($2::text[])`,
              [organizationId, references.map((entry) => entry.identifier)],
            )
          ).rows.map((issue) => ({
            ...issue,
            closes: references.some(
              (entry) => entry.identifier === issue.identifier && entry.closes,
            ),
          }))
        : [];
      await sql.query(
        "DELETE FROM cloud_github_pull_request_issues WHERE organization_id=$1 AND pull_request_id=$2",
        [organizationId, id],
      );
      for (const issue of issues)
        await sql.query(
          "INSERT INTO cloud_github_pull_request_issues (organization_id,pull_request_id,issue_id,closes) VALUES ($1,$2,$3,$4)",
          [organizationId, id, issue.id, issue.closes],
        );
      const event = pullRequestAutomationEvent({ state, draft, review }, true);
      const previousEvent =
        previous && pullRequestAutomationEvent(previous, true);
      return {
        id,
        steps:
          connection.automate && event !== previousEvent
            ? await automationSteps(sql, organizationId, id, event, issues)
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
        await this.recordError(connection.organizationId, error.message);
      }
    }
    return id;
  }

  async refresh(
    connection: GitHubConnectionRecord,
    repositoryId: string,
    fullName: string,
    number: number,
  ): Promise<void> {
    const client = new GitHubClient(connection, this.transport);
    const [pullRequest, review] = await Promise.all([
      client.pullRequest(fullName, number),
      client.reviewDecision(fullName, number),
    ]);
    const checks = await client.checks(fullName, pullRequest.head.sha);
    await this.store(connection, repositoryId, pullRequest, {
      checks: checks.conclusion,
      review,
    });
  }

  private async recordError(organizationId: string, message: string) {
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_github_connections SET last_error=$2 WHERE organization_id=$1",
        [organizationId, message.slice(0, 500)],
      ),
    );
  }

  private claimConnection(): Promise<{
    connection: GitHubConnectionRecord;
    repositories: { id: string; fullName: string; syncedAt: Date | null }[];
  } | null> {
    return this.database.transaction(async (sql) => {
      await sql.query(
        `DELETE FROM cloud_github_deliveries WHERE received_at < clock_timestamp() - interval '${deliveryRetentionDays} days'`,
      );
      const due = (
        await sql.query<{ organization_id: string }>(
          `SELECT organization_id FROM cloud_github_connections
          WHERE sync_requested_at IS NOT NULL OR synced_at IS NULL OR synced_at < clock_timestamp() - interval '${syncIntervalMinutes} minutes'
          ORDER BY sync_requested_at NULLS LAST, synced_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!due) return null;
      await sql.query(
        "UPDATE cloud_github_connections SET synced_at=clock_timestamp(),sync_requested_at=NULL WHERE organization_id=$1",
        [due.organization_id],
      );
      return {
        connection: await githubConnection(
          sql,
          this.cipher,
          due.organization_id,
        ),
        repositories: (
          await sql.query<{
            id: string;
            fullName: string;
            syncedAt: Date | null;
          }>(
            `SELECT id,full_name AS "fullName",synced_at AS "syncedAt" FROM cloud_github_repositories WHERE organization_id=$1`,
            [due.organization_id],
          )
        ).rows,
      };
    });
  }

  private async syncConnection(): Promise<number> {
    const claimed = await this.claimConnection();
    if (!claimed) return 0;
    const { connection, repositories } = claimed;
    const client = new GitHubClient(connection, this.transport);
    let failure: string | null = null;
    for (const repository of repositories) {
      try {
        const started = new Date();
        const automation = repository.syncedAt
          ? connection
          : { ...connection, automate: false };
        for (const pullRequest of await client.pullRequests(
          repository.fullName,
        )) {
          if (
            repository.syncedAt &&
            Date.parse(pullRequest.updated_at) < repository.syncedAt.getTime()
          )
            break;
          await this.store(automation, repository.id, pullRequest);
        }
        await this.database.transaction((sql) =>
          sql.query(
            "UPDATE cloud_github_repositories SET synced_at=$3 WHERE organization_id=$1 AND id=$2",
            [connection.organizationId, repository.id, started],
          ),
        );
      } catch (error) {
        if (!isCloudError(error)) throw error;
        failure = `${repository.fullName}: ${error.message}`;
      }
    }
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_github_connections SET last_error=$2 WHERE organization_id=$1",
        [connection.organizationId, failure?.slice(0, 500) ?? null],
      ),
    );
    return 1;
  }

  private async refreshStale(): Promise<number> {
    const stale = await this.database.transaction(async (sql) => {
      const row = (
        await sql.query<{
          organization_id: string;
          id: string;
          repository_id: string;
          number: number;
          full_name: string;
        }>(
          `SELECT p.organization_id,p.id,p.repository_id,p.number,r.full_name FROM cloud_github_pull_requests p
          JOIN cloud_github_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
          WHERE p.state='open' AND (p.signals_synced_at IS NULL OR (p.checks='pending' AND r.hook_id IS NULL
            AND p.signals_synced_at < clock_timestamp() - interval '${pendingChecksIntervalMinutes} minutes'))
          ORDER BY p.signals_synced_at NULLS FIRST LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return null;
      await sql.query(
        "UPDATE cloud_github_pull_requests SET signals_synced_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [row.organization_id, row.id],
      );
      return {
        ...row,
        connection: await githubConnection(
          sql,
          this.cipher,
          row.organization_id,
        ),
      };
    });
    if (!stale) return 0;
    try {
      await this.refresh(
        stale.connection,
        stale.repository_id,
        stale.full_name,
        stale.number,
      );
    } catch (error) {
      if (!isCloudError(error)) throw error;
      await this.recordError(
        stale.organization_id,
        `${stale.full_name}#${stale.number}: ${error.message}`,
      );
    }
    return 1;
  }

  async tick(): Promise<number> {
    if (!this.cipher) return 0;
    return (await this.syncConnection()) + (await this.refreshStale());
  }

  async receive(
    webhookId: string,
    headers: { event: string; delivery: string; signature: string },
    body: Buffer,
  ): Promise<void> {
    const connection = await this.database.transaction((sql) =>
      githubConnectionByWebhook(sql, this.cipher, webhookId),
    );
    if (!connection)
      throw new CloudError(404, "not_found", "This webhook is unavailable.");
    const expected = Buffer.from(
      `sha256=${createHmac("sha256", connection.webhookSecret).update(body).digest("hex")}`,
    );
    const supplied = Buffer.from(headers.signature);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new CloudError(
        401,
        "github_signature",
        "The signature is invalid.",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw new CloudError(
        400,
        "invalid_json",
        "The webhook body is not JSON.",
      );
    }
    const pullRequest = ["pull_request", "pull_request_review"].includes(
      headers.event,
    )
      ? pullRequestPayloadSchema.safeParse(parsed)
      : null;
    const check = ["check_run", "check_suite"].includes(headers.event)
      ? checkPayloadSchema.safeParse(parsed)
      : null;
    const repositoryId = await this.database.transaction(async (sql) => {
      const fresh = await sql.query(
        "INSERT INTO cloud_github_deliveries (delivery_id,organization_id,event) VALUES ($1,$2,$3) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id",
        [
          headers.delivery,
          connection.organizationId,
          headers.event.slice(0, 60),
        ],
      );
      const payload = pullRequest?.success
        ? pullRequest.data
        : check?.success
          ? check.data
          : null;
      if (!fresh.rows.length || !payload) return null;
      const repository = (
        await sql.query<{ id: string }>(
          "SELECT id FROM cloud_github_repositories WHERE organization_id=$1 AND github_id=$2",
          [connection.organizationId, payload.repository.id],
        )
      ).rows[0];
      const headSha =
        check?.success &&
        (check.data.check_run?.head_sha ?? check.data.check_suite?.head_sha);
      if (repository && headSha)
        await sql.query(
          "UPDATE cloud_github_pull_requests SET signals_synced_at=NULL WHERE organization_id=$1 AND repository_id=$2 AND head_sha=$3 AND state='open'",
          [connection.organizationId, repository.id, headSha],
        );
      return repository?.id ?? null;
    });
    if (!repositoryId || !pullRequest?.success) return;
    await this.store(connection, repositoryId, pullRequest.data.pull_request);
  }
}
