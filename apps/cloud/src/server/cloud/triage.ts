import type { CloudActor, CloudIssue } from "../../lib/cloud-contract";
import type {
  TriageDecision,
  TriageIssue,
  TriageResult,
} from "../../lib/cloud-triage-contract";
import type { CloudWorkflowStatus } from "../../lib/cloud-workflow-contract";
import {
  checkRevision,
  CloudError,
  command,
  requireMembership,
  teamVisibility,
} from "./access";
import { insertComment } from "./comments";
import type { CloudDatabase, CloudSql } from "./database";
import { lockExecution } from "./execution/records";
import { applyIssueChangeSet } from "./issue-changes";
import { insertIssueRelation } from "./issue-graph";
import { readIssue } from "./planning";
import { issueSummaryColumns } from "./planning-queries";
import { resolveIssueStatus } from "./workflow-records";

const statusColumns = "s.id,s.name,s.category,s.archived,s.revision";

async function acceptedStatus(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
  reference: TriageDecision & { decision: "accept" },
): Promise<CloudWorkflowStatus> {
  if (reference.status) {
    const status = await resolveIssueStatus(
      sql,
      actor,
      issue.teamId,
      reference.status,
    );
    if (status.category === "triage")
      throw new CloudError(
        422,
        "triage_status",
        "Choose a status outside triage.",
      );
    return status;
  }
  const status = (
    await sql.query<CloudWorkflowStatus & Record<string, unknown>>(
      `SELECT ${statusColumns} FROM cloud_workflow_statuses s JOIN cloud_team_workflows w ON w.organization_id=s.organization_id AND w.team_id=s.team_id
      WHERE s.organization_id=$1 AND s.team_id=$2 AND NOT s.archived AND s.category NOT IN ('triage','complete','canceled')
      ORDER BY (s.id=w.default_status_id) DESC,s.position LIMIT 1`,
      [actor.organizationId, issue.teamId],
    )
  ).rows[0];
  if (!status)
    throw new CloudError(
      422,
      "status_unavailable",
      `${issue.identifier} has no open status to accept into.`,
    );
  return status;
}

async function canceledStatus(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
): Promise<CloudWorkflowStatus> {
  const status = (
    await sql.query<CloudWorkflowStatus & Record<string, unknown>>(
      `SELECT ${statusColumns} FROM cloud_workflow_statuses s
      WHERE s.organization_id=$1 AND s.team_id=$2 AND NOT s.archived AND s.category='canceled' ORDER BY s.position LIMIT 1`,
      [actor.organizationId, issue.teamId],
    )
  ).rows[0];
  if (!status)
    throw new CloudError(
      422,
      "status_unavailable",
      `${issue.identifier} has no canceled status in its team.`,
    );
  return status;
}

export class CloudTriage {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, teamId: string | null): Promise<TriageIssue[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<TriageIssue & Record<string, unknown>>(
          `SELECT ${issueSummaryColumns},i.description,
          (SELECT u.name FROM cloud_issue_history h JOIN cloud_users u ON u.id=h.actor_id
            WHERE h.organization_id=i.organization_id AND h.issue_id=i.id ORDER BY h.revision LIMIT 1) AS creator
        FROM cloud_issues i
        JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
        JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
        JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
        WHERE i.organization_id=$1 AND i.state='triage' AND NOT i.archived AND ($3::uuid IS NULL OR i.team_id=$3) AND ${teamVisibility}
        ORDER BY i.created_at DESC,i.id LIMIT 200`,
          [actor.organizationId, actor.userId, teamId],
        )
      ).rows;
    });
  }

  counts(actor: CloudActor): Promise<Record<string, number>> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const rows = (
        await sql.query<{ teamId: string; count: number }>(
          `SELECT i.team_id AS "teamId",count(*)::int AS count FROM cloud_issues i
          JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
          JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
          WHERE i.organization_id=$1 AND i.state='triage' AND NOT i.archived AND ${teamVisibility}
          GROUP BY i.team_id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
      return Object.fromEntries(rows.map((row) => [row.teamId, row.count]));
    });
  }

  decide(
    actor: CloudActor,
    commandId: string,
    issueId: string,
    input: TriageDecision,
  ): Promise<TriageResult> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const issue = await readIssue(sql, actor, issueId, true);
      const original =
        input.decision === "duplicate"
          ? await readIssue(sql, actor, input.duplicateOfId)
          : null;
      return command(
        sql,
        actor,
        commandId,
        { kind: "issue.triage", issueId, input },
        async () => {
          checkRevision(issue.revision, input.revision);
          if (issue.archived || issue.state !== "triage")
            throw new CloudError(
              409,
              "triage_settled",
              `${issue.identifier} is no longer in triage.`,
            );
          if (original?.archived)
            throw new CloudError(
              409,
              "issue_archived",
              `Restore ${original.identifier} before marking duplicates of it.`,
            );
          const status =
            input.decision === "accept"
              ? await acceptedStatus(sql, actor, issue, input)
              : await canceledStatus(sql, actor, issue);
          if (original)
            await insertIssueRelation(
              sql,
              actor,
              "duplicate",
              issue.id,
              original.id,
            );
          const revision = await applyIssueChangeSet(sql, actor, issue, {
            status: { id: status.id, revision: status.revision },
          });
          if (input.decision === "decline" && input.reason)
            await insertComment(sql, actor, issue, input.reason);
          return { id: issue.id, revision, statusName: status.name };
        },
      );
    });
  }
}
