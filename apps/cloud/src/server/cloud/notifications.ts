import { randomUUID } from "node:crypto";
import type { CloudActor, CloudIssue } from "../../lib/cloud-contract";
import type {
  InboxEntry,
  InboxKind,
  InboxUpdate,
} from "../../lib/cloud-inbox-contract";
import { requireMembership, teamVisibility } from "./access";
import type { PullRequestStage } from "../../lib/git-automation";
import type { CloudDatabase, CloudSql } from "./database";
import { issueSubscribedClause } from "./subscription-records";

const maximumDetailLength = 240;
const issueAudience = `SELECT u.id,u.name,${issueSubscribedClause} AS subscribed
  FROM cloud_issues i
  JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
  JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.active
  JOIN cloud_users u ON u.id=m.user_id AND NOT u.disabled
  WHERE i.organization_id=$1 AND i.id=$2 AND u.id<>$3
  AND cloud_team_visible(t.organization_id,t.id,t.visibility,m.user_id)`;
const pageSize = 100;
const nobody = "00000000-0000-0000-0000-000000000000";

function excerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maximumDetailLength
    ? `${compact.slice(0, maximumDetailLength - 1)}…`
    : compact;
}

async function insertNotification(
  sql: CloudSql,
  entry: {
    organizationId: string;
    userId: string;
    teamId: string;
    kind: InboxKind;
    issueId: string | null;
    runId: string | null;
    automationRunId?: string;
    actorId: string | null;
    automation?: string;
    detail: string;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO cloud_notifications (organization_id,id,user_id,team_id,kind,issue_id,run_id,actor_id,automation,detail,automation_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [
      entry.organizationId,
      randomUUID(),
      entry.userId,
      entry.teamId,
      entry.kind,
      entry.issueId,
      entry.runId,
      entry.actorId,
      entry.automation ?? null,
      excerpt(entry.detail),
      entry.automationRunId ?? null,
    ],
  );
}

export async function notifyLoop(
  sql: CloudSql,
  entry: {
    organizationId: string;
    userId: string;
    teamId: string;
    kind: "loop_input" | "loop_approval" | "loop_message";
    automationRunId: string;
    issueId: string | null;
    actorId: string;
    automation: string;
    detail: string;
  },
): Promise<void> {
  await insertNotification(sql, { ...entry, runId: null });
}

export async function notifyAssignment(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
  previousAssigneeId: string | null,
): Promise<void> {
  if (
    !issue.assigneeId ||
    (issue.assigneeId === actor.userId && !actor.automation) ||
    issue.assigneeId === previousAssigneeId
  )
    return;
  await insertNotification(sql, {
    organizationId: actor.organizationId,
    userId: issue.assigneeId,
    teamId: issue.teamId,
    kind: "assigned",
    issueId: issue.id,
    runId: null,
    actorId: actor.userId,
    automation: actor.automation,
    detail: "",
  });
}

function mentions(text: string, name: string): boolean {
  const handle = `@${name.toLowerCase()}`;
  let index = text.indexOf(handle);
  while (index !== -1) {
    const next = text[index + handle.length];
    if (!next || !/[\p{L}\p{N}]/u.test(next)) return true;
    index = text.indexOf(handle, index + 1);
  }
  return false;
}

export async function notifyComment(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
  body: string,
): Promise<void> {
  const audience = (
    await sql.query<{ id: string; name: string; subscribed: boolean }>(
      issueAudience,
      [actor.organizationId, issue.id, actor.userId],
    )
  ).rows;
  const text = body.toLowerCase();
  for (const member of audience) {
    const mentioned = mentions(text, member.name);
    if (!mentioned && !member.subscribed) continue;
    await insertNotification(sql, {
      organizationId: actor.organizationId,
      userId: member.id,
      teamId: issue.teamId,
      kind: mentioned ? "mentioned" : "commented",
      issueId: issue.id,
      runId: null,
      actorId: actor.userId,
      detail: body,
    });
  }
}

export async function notifyStatusChange(
  sql: CloudSql,
  actor: CloudActor,
  before: CloudIssue,
  after: CloudIssue,
): Promise<void> {
  if (before.status.id === after.status.id) return;
  const audience = (
    await sql.query<{ id: string; subscribed: boolean }>(issueAudience, [
      actor.organizationId,
      after.id,
      actor.automation ? nobody : actor.userId,
    ])
  ).rows;
  for (const member of audience) {
    if (!member.subscribed) continue;
    await insertNotification(sql, {
      organizationId: actor.organizationId,
      userId: member.id,
      teamId: after.teamId,
      kind: "status_changed",
      issueId: after.id,
      runId: null,
      actorId: actor.userId,
      automation: actor.automation,
      detail: after.statusName,
    });
  }
}

const pullRequestStageDetails: Partial<Record<PullRequestStage, string>> = {
  attention: "needs attention",
  ready: "is ready to merge",
  review: "is waiting for review",
  merged: "was merged",
  closed: "was closed",
};

export async function notifyPullRequestStage(
  sql: CloudSql,
  change: {
    organizationId: string;
    actorId: string;
    issueId: string;
    teamId: string;
    reference: string;
    title: string;
    stage: PullRequestStage;
  },
): Promise<void> {
  const detail = pullRequestStageDetails[change.stage];
  if (!detail) return;
  const audience = (
    await sql.query<{ id: string; subscribed: boolean }>(issueAudience, [
      change.organizationId,
      change.issueId,
      nobody,
    ])
  ).rows;
  for (const member of audience) {
    if (!member.subscribed) continue;
    await insertNotification(sql, {
      organizationId: change.organizationId,
      userId: member.id,
      teamId: change.teamId,
      kind: "pull_request",
      issueId: change.issueId,
      runId: null,
      actorId: change.actorId,
      detail: `${change.reference} ${detail}: ${change.title}`,
    });
  }
}

export async function notifySlaBreach(
  sql: CloudSql,
  breach: { organizationId: string; issueId: string; teamId: string },
): Promise<void> {
  const audience = (
    await sql.query<{ id: string; subscribed: boolean }>(issueAudience, [
      breach.organizationId,
      breach.issueId,
      nobody,
    ])
  ).rows;
  for (const member of audience) {
    if (!member.subscribed) continue;
    await insertNotification(sql, {
      organizationId: breach.organizationId,
      userId: member.id,
      teamId: breach.teamId,
      kind: "sla_breached",
      issueId: breach.issueId,
      runId: null,
      actorId: null,
      detail: "",
    });
  }
}

export async function notifyRunFinished(
  sql: CloudSql,
  run: {
    organizationId: string;
    id: string;
    actorId: string;
    teamId: string;
    issueId: string | null;
    summary: string | null;
  },
): Promise<void> {
  await insertNotification(sql, {
    organizationId: run.organizationId,
    userId: run.actorId,
    teamId: run.teamId,
    kind: "task_finished",
    issueId: run.issueId,
    runId: run.id,
    actorId: run.actorId,
    detail: run.summary ?? "",
  });
}

export class CloudInbox {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<InboxEntry[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<InboxEntry & Record<string, unknown>>(
          `SELECT n.id,n.kind,n.detail,n.read_at IS NOT NULL AS read,
             to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
             COALESCE(n.automation,author.name) AS actor,n.issue_id AS "issueId",i.identifier AS "issueIdentifier",i.title AS "issueTitle",i.state AS "issueState",
             n.run_id AS "runId",r.title AS "runTitle",r.state AS "runState",
             n.automation_run_id AS "automationRunId",ar.automation_id AS "loopId"
           FROM cloud_notifications n
           JOIN cloud_teams t ON t.organization_id=n.organization_id AND t.id=n.team_id
           JOIN cloud_memberships m ON m.organization_id=n.organization_id AND m.user_id=n.user_id
           LEFT JOIN cloud_issues i ON i.organization_id=n.organization_id AND i.id=n.issue_id
           LEFT JOIN cloud_runs r ON r.organization_id=n.organization_id AND r.id=n.run_id
           LEFT JOIN cloud_automation_runs ar ON ar.organization_id=n.organization_id AND ar.id=n.automation_run_id
           LEFT JOIN cloud_users author ON author.id=n.actor_id
           WHERE n.organization_id=$1 AND n.user_id=$2 AND n.dismissed_at IS NULL AND ${teamVisibility}
           ORDER BY n.created_at DESC,n.id LIMIT ${pageSize}`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  unread(actor: CloudActor): Promise<number> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const result = await sql.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM cloud_notifications n
         JOIN cloud_teams t ON t.organization_id=n.organization_id AND t.id=n.team_id
         JOIN cloud_memberships m ON m.organization_id=n.organization_id AND m.user_id=n.user_id
         WHERE n.organization_id=$1 AND n.user_id=$2 AND n.read_at IS NULL AND n.dismissed_at IS NULL AND ${teamVisibility}`,
        [actor.organizationId, actor.userId],
      );
      return result.rows[0]!.count;
    });
  }

  update(actor: CloudActor, input: InboxUpdate): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      if (input.kind === "read-all")
        await sql.query(
          "UPDATE cloud_notifications SET read_at=clock_timestamp() WHERE organization_id=$1 AND user_id=$2 AND read_at IS NULL",
          [actor.organizationId, actor.userId],
        );
      else if (input.kind === "read")
        await sql.query(
          "UPDATE cloud_notifications SET read_at=CASE WHEN $4 THEN COALESCE(read_at,clock_timestamp()) ELSE NULL END WHERE organization_id=$1 AND user_id=$2 AND id=ANY($3::uuid[])",
          [actor.organizationId, actor.userId, input.ids, input.read],
        );
      else
        await sql.query(
          "UPDATE cloud_notifications SET dismissed_at=clock_timestamp(),read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=$1 AND user_id=$2 AND id=ANY($3::uuid[])",
          [actor.organizationId, actor.userId, input.ids],
        );
    });
  }
}
