import type { CloudActor, IssueFilters } from "../../lib/cloud-contract";

export const cycleColumns = `id,team_id AS "teamId",name,to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(ends_on,'YYYY-MM-DD') AS "endsOn",timezone,capacity,revision,status`;

export const issueColumns = `i.id, i.team_id AS "teamId", i.identifier, i.title, i.description, i.acceptance_criteria AS "acceptanceCriteria",
  (SELECT jsonb_build_object('id',s.id,'revision',s.revision) FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS status,
  (SELECT s.name FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS "statusName",
  i.state, i.priority, i.project_id AS "projectId", i.cycle_id AS "cycleId", i.assignee_id AS "assigneeId",
  i.estimate, i.estimate_points AS "estimatePoints", to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.archived, i.revision,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

export const issueSummaryColumns = `i.id, i.team_id AS "teamId", i.identifier, i.title,
  jsonb_build_object('id',s.id,'revision',s.revision) AS status, s.name AS "statusName",
  i.state, i.priority, i.project_id AS "projectId", i.cycle_id AS "cycleId", i.assignee_id AS "assigneeId",
  i.estimate, i.estimate_points AS "estimatePoints", to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.archived, i.revision,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color) ORDER BY lower(l.name),l.id)
    FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
    WHERE a.organization_id=i.organization_id AND a.issue_id=i.id),'[]'::jsonb) AS labels,
  (SELECT jsonb_build_object('id',r.id,'state',r.state) FROM cloud_runs r
    WHERE r.organization_id=i.organization_id AND r.issue_id=i.id AND r.state NOT IN ('succeeded','failed','canceled','timed_out')) AS "activeRun"`;

export const issueFilterClause = `i.organization_id=$1 AND i.archived=$3
  AND ($4::uuid IS NULL OR i.team_id=$4) AND ($5::uuid IS NULL OR i.project_id=$5) AND ($6::uuid IS NULL OR i.cycle_id=$6)
  AND ($7='' OR strpos(lower(i.title || ' ' || i.identifier || ' ' || i.description), lower($7))>0)
  AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM cloud_issue_labels a WHERE a.organization_id=i.organization_id AND a.issue_id=i.id AND a.label_id=$9))
  AND ($10::uuid IS NULL OR i.status_id=$10)
  AND ($11::text[] IS NULL OR i.state=ANY($11::text[]))
  AND (NOT $12::boolean OR i.assignee_id=$2)
  AND ($13::uuid IS NULL OR i.assignee_id=$13)
  AND (NOT $14::boolean OR i.assignee_id IS NULL)
  AND ($15::text IS NULL OR i.priority=$15)
  AND (NOT $16::boolean OR i.estimate IS NULL)
  AND (NOT $17::boolean OR i.cycle_id IS NULL)`;

export function issueFilterParameters(
  actor: CloudActor,
  filters: IssueFilters,
): unknown[] {
  return [
    actor.organizationId,
    actor.userId,
    filters.archived ?? false,
    filters.teamId ?? null,
    filters.projectId ?? null,
    filters.cycleId ?? null,
    filters.query ?? "",
    filters.offset ?? 0,
    filters.labelId ?? null,
    filters.statusId ?? null,
    filters.states ?? null,
    filters.assignedToActor ?? false,
    filters.assigneeId ?? null,
    filters.unassigned ?? false,
    filters.priority ?? null,
    filters.unestimated ?? false,
    filters.noCycle ?? false,
  ];
}

export const projectColumns = `id,team_id AS "teamId",name,description,status,lead_id AS "leadId",to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(target_on,'YYYY-MM-DD') AS "targetOn",revision`;
