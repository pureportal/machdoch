import { randomUUID } from "node:crypto";
import type { CloudActor, CloudIssue } from "../../lib/cloud-contract";
import type {
  InboxEntry,
  InboxKind,
  InboxUpdate,
} from "../../lib/cloud-inbox-contract";
import { requireMembership, teamVisibility } from "./access";
import type { CloudDatabase, CloudSql } from "./database";

const maximumDetailLength = 240;
const pageSize = 100;

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
    actorId: string;
    detail: string;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO cloud_notifications (organization_id,id,user_id,team_id,kind,issue_id,run_id,actor_id,detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [
      entry.organizationId,
      randomUUID(),
      entry.userId,
      entry.teamId,
      entry.kind,
      entry.issueId,
      entry.runId,
      entry.actorId,
      excerpt(entry.detail),
    ],
  );
}

export async function notifyAssignment(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
  previousAssigneeId: string | null,
): Promise<void> {
  if (
    !issue.assigneeId ||
    issue.assigneeId === actor.userId ||
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
    await sql.query<{ id: string; name: string; participating: boolean }>(
      `SELECT u.id,u.name,(u.id=$3 OR EXISTS (SELECT 1 FROM cloud_comments c WHERE c.organization_id=$1 AND c.issue_id=$2 AND c.author_id=u.id AND NOT c.deleted)) AS participating
       FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id
       JOIN cloud_teams t ON t.organization_id=m.organization_id AND t.id=$4
       WHERE m.organization_id=$1 AND m.active AND NOT u.disabled AND u.id<>$5
       AND (t.visibility='organization' OR m.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM cloud_team_memberships tm WHERE tm.organization_id=m.organization_id AND tm.team_id=t.id AND tm.user_id=m.user_id))`,
      [
        actor.organizationId,
        issue.id,
        issue.assigneeId,
        issue.teamId,
        actor.userId,
      ],
    )
  ).rows;
  const text = body.toLowerCase();
  for (const member of audience) {
    const mentioned = mentions(text, member.name);
    if (!mentioned && !member.participating) continue;
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
             author.name AS actor,n.issue_id AS "issueId",i.identifier AS "issueIdentifier",i.title AS "issueTitle",i.state AS "issueState",
             n.run_id AS "runId",r.title AS "runTitle",r.state AS "runState"
           FROM cloud_notifications n
           JOIN cloud_teams t ON t.organization_id=n.organization_id AND t.id=n.team_id
           JOIN cloud_memberships m ON m.organization_id=n.organization_id AND m.user_id=n.user_id
           LEFT JOIN cloud_issues i ON i.organization_id=n.organization_id AND i.id=n.issue_id
           LEFT JOIN cloud_runs r ON r.organization_id=n.organization_id AND r.id=n.run_id
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
