export const cycleColumns = `id,team_id AS "teamId",name,to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(ends_on,'YYYY-MM-DD') AS "endsOn",timezone,capacity,revision,status`;

export const issueColumns = `i.id, i.team_id AS "teamId", i.identifier, i.title, i.description, i.acceptance_criteria AS "acceptanceCriteria",
  (SELECT jsonb_build_object('id',s.id,'revision',s.revision) FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS status,
  (SELECT s.name FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS "statusName",
  i.state, i.priority, i.project_id AS "projectId", i.cycle_id AS "cycleId", i.assignee_id AS "assigneeId",
  i.estimate, i.estimate_points AS "estimatePoints", to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.archived, i.revision,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

export const projectColumns = `id,team_id AS "teamId",name,description,status,lead_id AS "leadId",to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(target_on,'YYYY-MM-DD') AS "targetOn",revision`;
