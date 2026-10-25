import type { CloudActor, IssueInput } from "../../lib/cloud-contract";
import type {
  CloudTeamWorkflow,
  CloudWorkflowStatus,
} from "../../lib/cloud-workflow-contract";
import { CloudError } from "./access";
import type { CloudSql } from "./database";

export async function readTeamWorkflows(
  sql: CloudSql,
  organizationId: string,
  teamIds: string[],
): Promise<CloudTeamWorkflow[]> {
  return (
    await sql.query<CloudTeamWorkflow & Record<string, unknown>>(
      `SELECT w.team_id AS "teamId",w.revision,w.default_status_id AS "defaultStatusId",
    (SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'category',s.category,'archived',s.archived,'revision',s.revision) ORDER BY s.position)
      FROM cloud_workflow_statuses s WHERE s.organization_id=w.organization_id AND s.team_id=w.team_id) AS statuses
    FROM cloud_team_workflows w WHERE w.organization_id=$1 AND w.team_id=ANY($2::uuid[]) ORDER BY w.team_id`,
      [organizationId, teamIds],
    )
  ).rows;
}

export async function resolveIssueStatus(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  reference: IssueInput["status"],
  existingId?: string,
): Promise<CloudWorkflowStatus> {
  const status = (
    await sql.query<CloudWorkflowStatus & Record<string, unknown>>(
      `SELECT s.id,s.name,s.category,s.archived,s.revision FROM cloud_workflow_statuses s JOIN cloud_team_workflows w ON w.organization_id=s.organization_id AND w.team_id=s.team_id
    WHERE s.organization_id=$1 AND s.team_id=$2 AND s.id=COALESCE($3::uuid,w.default_status_id)`,
      [actor.organizationId, teamId, reference?.id ?? null],
    )
  ).rows[0];
  if (!status)
    throw new CloudError(
      422,
      "status_unavailable",
      "Choose a status in this issue's team.",
    );
  if (reference && status.revision !== reference.revision)
    throw new CloudError(
      409,
      "workflow_changed",
      "The status changed. Reload the workflow and choose a status before saving.",
    );
  if (status.archived && status.id !== existingId)
    throw new CloudError(
      409,
      "status_archived",
      "This status is archived. Choose an active status.",
    );
  return status;
}
