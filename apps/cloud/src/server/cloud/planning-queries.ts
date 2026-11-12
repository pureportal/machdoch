import type { CloudActor, IssueFilters } from "../../lib/cloud-contract";
import { pullRequestStages } from "../../lib/github-automation";
import {
  meFilterValue,
  noneFilterValue,
  type IssueFilterCondition,
} from "../../lib/issue-filter-model";

export const cycleColumns = `id,team_id AS "teamId",name,to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(ends_on,'YYYY-MM-DD') AS "endsOn",timezone,capacity,revision,status`;

export const issueColumns = `i.id, i.team_id AS "teamId", i.identifier, i.title, i.description, i.acceptance_criteria AS "acceptanceCriteria",
  (SELECT jsonb_build_object('id',s.id,'revision',s.revision) FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS status,
  (SELECT s.name FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS "statusName",
  i.state, i.priority, i.project_id AS "projectId", i.milestone_id AS "milestoneId", i.cycle_id AS "cycleId", i.assignee_id AS "assigneeId",
  i.estimate, i.estimate_points AS "estimatePoints", to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.archived, i.revision,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

const pullRequestStageOrder = `CASE p.stage ${pullRequestStages.map((stage, index) => `WHEN '${stage}' THEN ${index}`).join(" ")} END`;

export const issueSummaryColumns = `i.id, i.team_id AS "teamId", i.identifier, i.title,
  jsonb_build_object('id',s.id,'revision',s.revision) AS status, s.name AS "statusName",
  i.state, i.priority, i.project_id AS "projectId", i.milestone_id AS "milestoneId", i.cycle_id AS "cycleId", i.assignee_id AS "assigneeId",
  i.estimate, i.estimate_points AS "estimatePoints", to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.archived, i.revision,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color) ORDER BY lower(l.name),l.id)
    FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
    WHERE a.organization_id=i.organization_id AND a.issue_id=i.id),'[]'::jsonb) AS labels,
  (SELECT jsonb_build_object('id',r.id,'state',r.state) FROM cloud_runs r
    WHERE r.organization_id=i.organization_id AND r.issue_id=i.id AND r.state NOT IN ('succeeded','failed','canceled','timed_out')) AS "activeRun",
  (SELECT jsonb_build_object('stage',p.stage,'reference',gr.full_name || '#' || p.number,'count',count(*) OVER ())
    FROM cloud_github_pull_request_issues gl JOIN cloud_github_pull_requests p ON p.organization_id=gl.organization_id AND p.id=gl.pull_request_id
    JOIN cloud_github_repositories gr ON gr.organization_id=p.organization_id AND gr.id=p.repository_id
    WHERE gl.organization_id=i.organization_id AND gl.issue_id=i.id
    ORDER BY ${pullRequestStageOrder},p.updated_at DESC LIMIT 1) AS "pullRequest",
  (SELECT jsonb_build_object('id',pi.id,'identifier',pi.identifier,'title',pi.title)
    FROM cloud_issue_relations pr JOIN cloud_issues pi ON pi.organization_id=pr.organization_id AND pi.id=pr.source_id
    JOIN cloud_teams pt ON pt.organization_id=pi.organization_id AND pt.id=pi.team_id
    WHERE pr.organization_id=i.organization_id AND pr.kind='parent' AND pr.target_id=i.id AND pr.removed_at IS NULL
    AND (pt.visibility='organization' OR m.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM cloud_team_memberships ptm WHERE ptm.organization_id=pt.organization_id AND ptm.team_id=pt.id AND ptm.user_id=$2))) AS parent`;

const duePredicates: Record<string, string> = {
  overdue: "i.due_on<CURRENT_DATE",
  week: "i.due_on BETWEEN CURRENT_DATE AND CURRENT_DATE+7",
  month: "i.due_on BETWEEN CURRENT_DATE AND CURRENT_DATE+30",
  none: "i.due_on IS NULL",
};
const createdPredicates: Record<string, string> = {
  day: "i.created_at>=clock_timestamp()-interval '1 day'",
  week: "i.created_at>=clock_timestamp()-interval '7 days'",
  month: "i.created_at>=clock_timestamp()-interval '30 days'",
};
const updatedPredicates: Record<string, string> = {
  day: "i.updated_at>=clock_timestamp()-interval '1 day'",
  week: "i.updated_at>=clock_timestamp()-interval '7 days'",
  month: "i.updated_at>=clock_timestamp()-interval '30 days'",
};
const estimatePredicates: Record<string, string> = {
  none: "i.estimate IS NULL",
  set: "i.estimate IS NOT NULL",
};
const issueCreator =
  "(SELECT h.actor_id FROM cloud_issue_history h WHERE h.organization_id=i.organization_id AND h.issue_id=i.id ORDER BY h.revision LIMIT 1)";

function conditionPredicate(
  actor: CloudActor,
  condition: IssueFilterCondition,
  bind: (value: unknown) => string,
): string {
  const ids = condition.values
    .filter((value) => value !== noneFilterValue)
    .map((value) => (value === meFilterValue ? actor.userId : value));
  const none = condition.values.includes(noneFilterValue);
  const anyOf = (...predicates: (string | false)[]) =>
    predicates.filter(Boolean).join(" OR ");
  const reference = (column: string) =>
    anyOf(
      ids.length > 0 && `${column}=ANY(${bind(ids)}::uuid[])`,
      none && `${column} IS NULL`,
    );
  const mapped = (predicates: Record<string, string>) =>
    anyOf(...condition.values.map((value) => predicates[value] ?? false));
  switch (condition.field) {
    case "status":
      return reference("i.status_id");
    case "assignee":
      return reference("i.assignee_id");
    case "creator":
      return reference(issueCreator);
    case "priority":
      return `i.priority=ANY(${bind(condition.values)}::text[])`;
    case "project":
      return reference("i.project_id");
    case "cycle":
      return reference("i.cycle_id");
    case "label":
      return anyOf(
        ids.length > 0 &&
          `EXISTS (SELECT 1 FROM cloud_issue_labels a WHERE a.organization_id=i.organization_id AND a.issue_id=i.id AND a.label_id=ANY(${bind(ids)}::uuid[]))`,
        none &&
          "NOT EXISTS (SELECT 1 FROM cloud_issue_labels a WHERE a.organization_id=i.organization_id AND a.issue_id=i.id)",
      );
    case "estimate":
      return mapped(estimatePredicates);
    case "due":
      return mapped(duePredicates);
    case "created":
      return mapped(createdPredicates);
    case "updated":
      return mapped(updatedPredicates);
    case "pullRequest": {
      const stages = condition.values.filter(
        (value) => value !== noneFilterValue,
      );
      return anyOf(
        stages.length > 0 &&
          `EXISTS (SELECT 1 FROM cloud_github_pull_request_issues gl JOIN cloud_github_pull_requests p ON p.organization_id=gl.organization_id AND p.id=gl.pull_request_id
          WHERE gl.organization_id=i.organization_id AND gl.issue_id=i.id AND p.stage=ANY(${bind(stages)}::text[]))`,
        none &&
          "NOT EXISTS (SELECT 1 FROM cloud_github_pull_request_issues gl WHERE gl.organization_id=i.organization_id AND gl.issue_id=i.id)",
      );
    }
  }
}

export function issueFilterSql(
  actor: CloudActor,
  filters: IssueFilters,
): { where: string; parameters: unknown[] } {
  const parameters: unknown[] = [actor.organizationId, actor.userId];
  const bind = (value: unknown) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const clauses = [
    "i.organization_id=$1",
    `i.archived=${bind(filters.archived ?? false)}`,
  ];
  if (filters.teamId) clauses.push(`i.team_id=${bind(filters.teamId)}::uuid`);
  if (filters.query)
    clauses.push(
      `strpos(lower(i.title || ' ' || i.identifier || ' ' || i.description), lower(${bind(filters.query)}))>0`,
    );
  if (filters.states)
    clauses.push(`i.state=ANY(${bind(filters.states)}::text[])`);
  if (filters.assignedToActor) clauses.push("i.assignee_id=$2");
  for (const condition of filters.conditions ?? []) {
    const predicate = conditionPredicate(actor, condition, bind);
    if (!predicate) continue;
    clauses.push(
      `${condition.negated ? "NOT " : ""}COALESCE((${predicate}),false)`,
    );
  }
  return { where: clauses.join(" AND "), parameters };
}

export const projectColumns = `id,team_id AS "teamId",name,description,status,lead_id AS "leadId",to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(target_on,'YYYY-MM-DD') AS "targetOn",revision`;
