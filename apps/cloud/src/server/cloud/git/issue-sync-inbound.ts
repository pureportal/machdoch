import { randomUUID } from "node:crypto";
import {
  issueInputSchema,
  type CloudActor,
  type CloudIssue,
  type CloudTeam,
} from "../../../lib/cloud-contract";
import type { IssueChangeSet } from "../../../lib/cloud-issue-changes-contract";
import { isAutomationText } from "../../../lib/git-events";
import { gitProviderLabels } from "../../../lib/git-providers";
import { recordEvent, requireTeam } from "../access";
import { insertComment } from "../comments";
import type { CloudSql } from "../database";
import { lockExecution } from "../execution/records";
import { applyIssueChangeSet } from "../issue-changes";
import { lockIssueLabels, writeIssueLabels } from "../labels";
import { createIssueInTransaction, readIssue } from "../planning";
import { resolveIssueStatus } from "../workflow-records";
import type { GitConnectionRecord } from "./connections";
import type { StoredRepository } from "./events";
import type {
  GitIssueFields,
  GitIssueState,
  GitIssueUpdate,
} from "./git-client";
import type { IssueWebhook } from "./webhook-payloads";

export interface SyncedIssue {
  issueId: string;
  title: string;
  body: string;
  state: GitIssueState;
  assignee: string | null;
  assigneeId: string | null;
  issueRevision: number;
  labels: string[];
}

export const syncedIssueColumns = `s.issue_id AS "issueId",s.title,s.body,s.state,s.assignee,s.assignee_id AS "assigneeId",s.issue_revision AS "issueRevision",
COALESCE((SELECT array_agg(l.name ORDER BY l.name) FROM cloud_git_synced_issue_labels l WHERE l.organization_id=s.organization_id AND l.issue_id=s.issue_id),'{}') AS labels`;

const closedStates: Record<
  Exclude<GitIssueState, "open">,
  "complete" | "canceled"
> = { completed: "complete", not_planned: "canceled" };

async function mappedMember(
  sql: CloudSql,
  connection: GitConnectionRecord,
  team: CloudTeam,
  login: string,
): Promise<string | null> {
  return (
    (
      await sql.query<{ user_id: string }>(
        `SELECT a.user_id FROM cloud_git_accounts a JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=a.user_id
        JOIN cloud_users u ON u.id=a.user_id
        WHERE a.organization_id=$1 AND a.provider=$2 AND a.api_url=$3 AND lower(a.login)=lower($4) AND m.active AND NOT u.disabled
        AND cloud_team_visible(m.organization_id,$5,$6,m.user_id)`,
        [
          connection.organizationId,
          connection.provider,
          connection.apiUrl,
          login,
          team.id,
          team.visibility,
        ],
      )
    ).rows[0]?.user_id ?? null
  );
}

async function teamLabel(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  name: string,
): Promise<string | null> {
  const existing = (
    await sql.query<{ id: string; archived: boolean }>(
      "SELECT id,archived FROM cloud_labels WHERE organization_id=$1 AND team_id=$2 AND lower(name)=lower($3)",
      [actor.organizationId, teamId, name],
    )
  ).rows[0];
  if (existing) return existing.archived ? null : existing.id;
  const count = (
    await sql.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM cloud_labels WHERE organization_id=$1 AND team_id=$2",
      [actor.organizationId, teamId],
    )
  ).rows[0]!.count;
  if (count >= 200) return null;
  const id = randomUUID();
  await sql.query(
    "INSERT INTO cloud_labels (organization_id,id,team_id,name,color) VALUES ($1,$2,$3,$4,'gray')",
    [actor.organizationId, id, teamId, name],
  );
  await recordEvent(sql, actor, "label.created", id, 1, { teamId });
  return id;
}

async function applyLabels(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
  add: string[],
  remove: string[],
): Promise<{ added: string[]; removed: string[] }> {
  if (issue.archived || (!add.length && !remove.length))
    return { added: [], removed: [] };
  const current = await lockIssueLabels(sql, actor, issue.id);
  const removed = remove.map((name) => name.toLowerCase());
  const dropped = new Set(
    (
      await sql.query<{ id: string }>(
        "SELECT id FROM cloud_labels WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND lower(name)=ANY($3::text[])",
        [actor.organizationId, current.labelIds, removed],
      )
    ).rows.map((row) => row.id),
  );
  const labelIds = current.labelIds.filter((id) => !dropped.has(id));
  const added: string[] = [];
  for (const name of add) {
    const id = await teamLabel(sql, actor, issue.teamId, name);
    if (!id) continue;
    added.push(name.toLowerCase());
    if (!labelIds.includes(id)) labelIds.push(id);
  }
  await writeIssueLabels(sql, actor, issue, current, labelIds);
  return { added, removed };
}

async function cloudState(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
  state: GitIssueState,
): Promise<IssueChangeSet> {
  if (state !== "open") return { statusCategory: closedStates[state] };
  if (issue.state !== "complete" && issue.state !== "canceled") return {};
  const status = await resolveIssueStatus(sql, actor, issue.teamId, null);
  return { status: { id: status.id, revision: status.revision } };
}

async function writeLabelSnapshot(
  sql: CloudSql,
  organizationId: string,
  issueId: string,
  labels: { added: string[]; removed: string[] },
): Promise<void> {
  await sql.query(
    "DELETE FROM cloud_git_synced_issue_labels WHERE organization_id=$1 AND issue_id=$2 AND name=ANY($3::text[])",
    [organizationId, issueId, labels.removed],
  );
  await sql.query(
    "INSERT INTO cloud_git_synced_issue_labels (organization_id,issue_id,name) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING",
    [organizationId, issueId, labels.added],
  );
}

async function createSynced(
  sql: CloudSql,
  actor: CloudActor,
  connection: GitConnectionRecord,
  repository: StoredRepository,
  teamId: string,
  number: number,
  current: GitIssueFields & { url: string },
): Promise<string> {
  const team = await requireTeam(sql, actor, teamId, "issues.edit");
  const assigneeId = current.assignee
    ? await mappedMember(sql, connection, team, current.assignee)
    : null;
  const { id } = await createIssueInTransaction(
    sql,
    actor,
    team,
    issueInputSchema.parse({
      teamId,
      title: current.title,
      description: current.body,
      assigneeId,
    }),
  );
  const created = await readIssue(sql, actor, id, "issues.edit");
  await applyIssueChangeSet(
    sql,
    actor,
    created,
    await cloudState(sql, actor, created, current.state),
  );
  const labels = await applyLabels(sql, actor, created, current.labels, []);
  const issue = await readIssue(sql, actor, id);
  await sql.query(
    `INSERT INTO cloud_git_synced_issues (organization_id,issue_id,repository_id,number,url,title,body,state,assignee,assignee_id,issue_revision)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      actor.organizationId,
      id,
      repository.id,
      number,
      current.url,
      current.title,
      current.body,
      current.state,
      current.assignee,
      assigneeId,
      issue.revision,
    ],
  );
  await writeLabelSnapshot(sql, actor.organizationId, id, labels);
  return id;
}

async function updateSynced(
  sql: CloudSql,
  actor: CloudActor,
  connection: GitConnectionRecord,
  synced: SyncedIssue,
  changes: GitIssueUpdate,
): Promise<void> {
  const issue = await readIssue(sql, actor, synced.issueId, "issues.edit");
  const team = await requireTeam(sql, actor, issue.teamId);
  const next = { ...synced };
  const set: IssueChangeSet = {};
  if (changes.title !== undefined && changes.title !== synced.title)
    next.title = set.title = changes.title;
  if (changes.body !== undefined && changes.body !== synced.body)
    next.body = set.description = changes.body;
  if (changes.state !== undefined && changes.state !== synced.state) {
    next.state = changes.state;
    Object.assign(set, await cloudState(sql, actor, issue, changes.state));
  }
  if (changes.assignee !== undefined && changes.assignee !== synced.assignee) {
    next.assignee = changes.assignee;
    const assigneeId = changes.assignee
      ? await mappedMember(sql, connection, team, changes.assignee)
      : null;
    if (assigneeId || !changes.assignee) set.assigneeId = assigneeId;
    next.assigneeId = changes.assignee
      ? (assigneeId ?? issue.assigneeId)
      : null;
  }
  const revision = await applyIssueChangeSet(sql, actor, issue, set);
  const labels = await applyLabels(
    sql,
    actor,
    issue,
    changes.addLabels.filter(
      (name) => !synced.labels.includes(name.toLowerCase()),
    ),
    changes.removeLabels.filter((name) =>
      synced.labels.includes(name.toLowerCase()),
    ),
  );
  await sql.query(
    `UPDATE cloud_git_synced_issues SET title=$3,body=$4,state=$5,assignee=$6,assignee_id=$7,
    issue_revision=CASE WHEN issue_revision=$8 THEN $9 ELSE issue_revision END WHERE organization_id=$1 AND issue_id=$2`,
    [
      actor.organizationId,
      synced.issueId,
      next.title,
      next.body,
      next.state,
      next.assignee,
      next.assigneeId,
      issue.revision,
      revision,
    ],
  );
  await writeLabelSnapshot(sql, actor.organizationId, synced.issueId, labels);
}

async function receiveComment(
  sql: CloudSql,
  connection: GitConnectionRecord,
  issueId: string,
  comment: NonNullable<IssueWebhook["comment"]>,
): Promise<void> {
  if (!comment.body.trim() || isAutomationText(comment.body)) return;
  const mapped = await sql.query(
    "SELECT 1 FROM cloud_git_synced_comments WHERE organization_id=$1 AND issue_id=$2 AND external_id=$3",
    [connection.organizationId, issueId, comment.externalId],
  );
  if (mapped.rows.length) return;
  const connectionActor = {
    organizationId: connection.organizationId,
    userId: connection.actorId,
  };
  const issue = await readIssue(sql, connectionActor, issueId);
  const team = await requireTeam(sql, connectionActor, issue.teamId);
  const authorId = comment.author
    ? await mappedMember(sql, connection, team, comment.author)
    : null;
  const via = `via ${gitProviderLabels[connection.provider]}`;
  const { id } = await insertComment(
    sql,
    authorId
      ? { organizationId: connection.organizationId, userId: authorId }
      : connectionActor,
    issue,
    authorId
      ? comment.body
      : `${comment.author ? `**${comment.author}** ${via}` : via}\n\n${comment.body}`.slice(
          0,
          20_000,
        ),
  );
  await sql.query(
    "INSERT INTO cloud_git_synced_comments (organization_id,comment_id,issue_id,external_id) VALUES ($1,$2,$3,$4)",
    [connection.organizationId, id, issueId, comment.externalId],
  );
}

export async function receiveIssueWebhook(
  sql: CloudSql,
  connection: GitConnectionRecord,
  repository: StoredRepository,
  webhook: IssueWebhook,
): Promise<void> {
  const organizationId = connection.organizationId;
  await lockExecution(sql, organizationId);
  const settings = (
    await sql.query<{ team_id: string | null; issue_sync: boolean }>(
      "SELECT team_id,issue_sync FROM cloud_git_repositories WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [organizationId, repository.id],
    )
  ).rows[0];
  if (!settings?.issue_sync || !settings.team_id) return;
  const synced = (
    await sql.query<SyncedIssue & Record<string, unknown>>(
      `SELECT ${syncedIssueColumns} FROM cloud_git_synced_issues s WHERE s.organization_id=$1 AND s.repository_id=$2 AND s.number=$3`,
      [organizationId, repository.id, webhook.number],
    )
  ).rows[0];
  if (webhook.removed) {
    if (synced)
      await sql.query(
        "DELETE FROM cloud_git_synced_issues WHERE organization_id=$1 AND issue_id=$2",
        [organizationId, synced.issueId],
      );
    return;
  }
  const actor: CloudActor = {
    organizationId,
    userId: connection.actorId,
    automation: `${repository.fullName}#${webhook.number}`,
  };
  let issueId = synced?.issueId;
  if (synced)
    await updateSynced(sql, actor, connection, synced, webhook.changes);
  else if (webhook.current)
    issueId = await createSynced(
      sql,
      actor,
      connection,
      repository,
      settings.team_id,
      webhook.number,
      webhook.current,
    );
  if (issueId && webhook.comment)
    await receiveComment(sql, connection, issueId, webhook.comment);
}
