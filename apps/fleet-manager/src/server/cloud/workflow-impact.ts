import { createHash } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudTeamWorkflow,
  WorkflowDefinition,
  WorkflowImpact,
} from "../../lib/cloud-workflow-contract";
import { checkRevision, CloudError } from "./access";
import type { CloudSql } from "./database";

export async function workflowImpact(
  sql: CloudSql,
  actor: CloudActor,
  current: CloudTeamWorkflow,
  definition: WorkflowDefinition,
): Promise<WorkflowImpact & { scheduleIds: string[] }> {
  checkRevision(current.revision, definition.revision);
  const proposal = new Map(
    definition.statuses.map((status) => [status.id.toLowerCase(), status]),
  );
  if (current.statuses.some((status) => !proposal.has(status.id)))
    throw new CloudError(
      422,
      "workflow_status_missing",
      "Archive existing statuses instead of removing them.",
    );
  if (
    (
      await sql.query(
        "SELECT id FROM cloud_workflow_statuses WHERE organization_id=$1 AND team_id<>$2 AND id=ANY($3::uuid[])",
        [actor.organizationId, current.teamId, [...proposal.keys()]],
      )
    ).rows.length
  )
    throw new CloudError(
      422,
      "workflow_status_identity",
      "Create a new status identifier for this team.",
    );
  const recategorized = current.statuses
    .filter((status) => proposal.get(status.id)!.category !== status.category)
    .map((status) => status.id);
  const changed = current.statuses
    .filter((status) => {
      const next = proposal.get(status.id)!;
      return (
        next.category !== status.category || next.archived !== status.archived
      );
    })
    .map((status) => status.id);
  const issues = (
    await sql.query<{ id: string; revision: number }>(
      "SELECT id,revision FROM cloud_issues WHERE organization_id=$1 AND team_id=$2 AND status_id=ANY($3::uuid[]) ORDER BY id",
      [actor.organizationId, current.teamId, recategorized],
    )
  ).rows;
  const schedules = (
    await sql.query<{ id: string; revision: number }>(
      `SELECT id,revision FROM cloud_schedules WHERE organization_id=$1 AND enabled AND (
      (action->>'kind'='create-issue' AND action->'issue'->'status'->>'id'=ANY($2::text[])) OR
      (action->>'kind'='run-task' AND action->'run'->'subject'->>'kind'='issue' AND action->'run'->'subject'->>'id'=ANY($3::text[]))) ORDER BY id`,
      [actor.organizationId, changed, issues.map((issue) => issue.id)],
    )
  ).rows;
  const tasks = (
    await sql.query<{ id: string }>(
      `SELECT r.id FROM cloud_runs r WHERE r.organization_id=$1 AND r.state NOT IN ('succeeded','failed','canceled','timed_out') AND
      (r.issue_id=ANY($2::uuid[]) OR EXISTS (SELECT 1 FROM cloud_issue_relations e WHERE e.organization_id=r.organization_id AND e.kind='blocks' AND e.removed_at IS NULL AND e.target_id=r.issue_id AND e.source_id=ANY($2::uuid[]))) ORDER BY r.id`,
      [actor.organizationId, issues.map((issue) => issue.id)],
    )
  ).rows;
  return {
    digest: createHash("sha256")
      .update(JSON.stringify([definition, issues, schedules, tasks]))
      .digest("hex"),
    changedIssues: issues.length,
    pausedSchedules: schedules.length,
    changedTasks: tasks.length,
    scheduleIds: schedules.map((schedule) => schedule.id),
  };
}
