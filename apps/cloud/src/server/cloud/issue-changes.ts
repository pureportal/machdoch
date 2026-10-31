import type { CloudActor, CloudIssue } from "../../lib/cloud-contract";
import type {
  IssueChanges,
  IssueChangeSet,
  IssueChangesResult,
} from "../../lib/cloud-issue-changes-contract";
import type { CloudWorkflowStatus } from "../../lib/cloud-workflow-contract";
import {
  checkRevision,
  CloudError,
  command,
  requireTeam,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";
import { lockExecution } from "./execution/records";
import { notifyAssignment } from "./notifications";
import { readIssue, recordIssue, validateIssueLinks } from "./planning";
import { resolveIssueStatus } from "./workflow-records";

async function statusForChanges(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
  changes: IssueChangeSet,
): Promise<CloudWorkflowStatus | null> {
  if (changes.status)
    return resolveIssueStatus(
      sql,
      actor,
      issue.teamId,
      changes.status,
      issue.status.id,
    );
  if (!changes.statusCategory || changes.statusCategory === issue.state)
    return null;
  const status = (
    await sql.query<CloudWorkflowStatus & Record<string, unknown>>(
      `SELECT id,name,category,archived,revision FROM cloud_workflow_statuses
       WHERE organization_id=$1 AND team_id=$2 AND category=$3 AND NOT archived ORDER BY position LIMIT 1`,
      [actor.organizationId, issue.teamId, changes.statusCategory],
    )
  ).rows[0];
  if (!status)
    throw new CloudError(
      422,
      "status_unavailable",
      `${issue.identifier} has no matching status in its team.`,
    );
  return status;
}

export class CloudIssueChanges {
  constructor(private readonly database: CloudDatabase) {}

  apply(
    actor: CloudActor,
    commandId: string,
    input: IssueChanges,
  ): Promise<IssueChangesResult> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const ordered = [...input.issues].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      const issues: {
        reference: IssueChanges["issues"][number];
        issue: CloudIssue;
      }[] = [];
      for (const reference of ordered)
        issues.push({
          reference,
          issue: await readIssue(sql, actor, reference.id, true),
        });
      return command(
        sql,
        actor,
        commandId,
        { kind: "issue.changes", input },
        async () => {
          const updated: IssueChangesResult["updated"] = [];
          for (const { reference, issue } of issues) {
            if (reference.revision !== undefined)
              checkRevision(issue.revision, reference.revision);
            updated.push({
              id: issue.id,
              revision: await this.applyOne(sql, actor, issue, input.changes),
            });
          }
          return { updated };
        },
      );
    });
  }

  private async applyOne(
    sql: CloudSql,
    actor: CloudActor,
    issue: CloudIssue,
    changes: IssueChangeSet,
  ): Promise<number> {
    const team = await requireTeam(sql, actor, issue.teamId, true);
    const status = await statusForChanges(sql, actor, issue, changes);
    const next = {
      teamId: issue.teamId,
      title: changes.title ?? issue.title,
      description: changes.description ?? issue.description,
      acceptanceCriteria:
        changes.acceptanceCriteria ?? issue.acceptanceCriteria,
      status: issue.status,
      priority: changes.priority ?? issue.priority,
      assigneeId:
        changes.assigneeId === undefined ? issue.assigneeId : changes.assigneeId,
      projectId:
        changes.projectId === undefined ? issue.projectId : changes.projectId,
      cycleId: changes.cycleId === undefined ? issue.cycleId : changes.cycleId,
      estimate:
        changes.estimate === undefined ? issue.estimate : changes.estimate,
      dueOn: changes.dueOn === undefined ? issue.dueOn : changes.dueOn,
    };
    const archived = changes.archived ?? issue.archived;
    if (
      next.title === issue.title &&
      next.description === issue.description &&
      next.acceptanceCriteria === issue.acceptanceCriteria &&
      next.priority === issue.priority &&
      next.assigneeId === issue.assigneeId &&
      next.projectId === issue.projectId &&
      next.cycleId === issue.cycleId &&
      next.estimate === issue.estimate &&
      next.dueOn === issue.dueOn &&
      archived === issue.archived &&
      (!status || status.id === issue.status.id)
    )
      return issue.revision;
    const points = await validateIssueLinks(sql, actor, team, next, issue);
    await sql.query(
      `UPDATE cloud_issues SET title=$3,description=$4,acceptance_criteria=$5,state=$6,priority=$7,project_id=$8,cycle_id=$9,assignee_id=$10,
       estimate=$11,estimate_points=$12,estimate_scale_revision=CASE WHEN $13 THEN $14 ELSE estimate_scale_revision END,due_on=$15,archived=$16,status_id=$17,revision=revision+1,updated_at=clock_timestamp()
       WHERE organization_id=$1 AND id=$2`,
      [
        actor.organizationId,
        issue.id,
        next.title,
        next.description,
        next.acceptanceCriteria,
        status?.category ?? issue.state,
        next.priority,
        next.projectId,
        next.cycleId,
        next.assigneeId,
        next.estimate,
        points,
        issue.estimate !== next.estimate,
        team.scaleRevision,
        next.dueOn,
        archived,
        status?.id ?? issue.status.id,
      ],
    );
    const updated = await readIssue(sql, actor, issue.id);
    await recordIssue(sql, actor, updated);
    await notifyAssignment(sql, actor, updated, issue.assigneeId);
    return updated.revision;
  }
}
