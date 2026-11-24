import type { CloudActor, IssueFilters } from "../../lib/cloud-contract";
import { pullRequestStages } from "../../lib/git-automation";
import {
  meFilterValue,
  noneFilterValue,
  aiFilterValue,
  type IssueFilterCondition,
  type IssueFilterField,
} from "../../lib/issue-filter-model";
import { slaAtRiskHours, type SlaState } from "../../lib/issue-sla";

export const cycleColumns = `id,team_id AS "teamId",name,to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(ends_on,'YYYY-MM-DD') AS "endsOn",timezone,capacity,revision,status`;

export const issueColumns = `i.id, i.team_id AS "teamId", i.identifier, i.title, i.description, i.acceptance_criteria AS "acceptanceCriteria",
  (SELECT jsonb_build_object('id',s.id,'revision',s.revision) FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS status,
  (SELECT s.name FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.id=i.status_id) AS "statusName",
  i.state, i.priority, i.project_id AS "projectId", i.milestone_id AS "milestoneId", i.cycle_id AS "cycleId", i.assignee_id AS "assigneeId", i.ai_assigned AS "aiAssigned",
  i.estimate, i.estimate_points AS "estimatePoints", to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.archived, i.revision,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

const pullRequestStageOrder = `CASE p.stage ${pullRequestStages.map((stage, index) => `WHEN '${stage}' THEN ${index}`).join(" ")} END`;

export const issueSummaryColumns = `i.id, i.team_id AS "teamId", i.identifier, i.title,
  jsonb_build_object('id',s.id,'revision',s.revision) AS status, s.name AS "statusName",
  i.state, i.priority, i.project_id AS "projectId", i.milestone_id AS "milestoneId", i.cycle_id AS "cycleId", i.assignee_id AS "assigneeId", i.ai_assigned AS "aiAssigned",
  i.estimate, i.estimate_points AS "estimatePoints", to_char(i.due_on, 'YYYY-MM-DD') AS "dueOn", i.archived, i.revision,
  to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(cloud_issue_sla_due(i.organization_id,i.id) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "slaDueAt",
  (SELECT count(*)::int FROM cloud_customer_requests cr WHERE cr.organization_id=i.organization_id AND cr.issue_id=i.id) AS "requestCount",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color) ORDER BY lower(l.name),l.id)
    FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
    WHERE a.organization_id=i.organization_id AND a.issue_id=i.id),'[]'::jsonb) AS labels,
  (SELECT jsonb_build_object('id',r.id,'state',r.state) FROM cloud_runs r
    WHERE r.organization_id=i.organization_id AND r.issue_id=i.id AND r.state NOT IN ('succeeded','failed','canceled','timed_out')) AS "activeRun",
  (SELECT jsonb_build_object('stage',p.stage,'reference',gr.full_name || '#' || p.number,'count',count(*) OVER ())
    FROM cloud_git_pull_request_issues gl JOIN cloud_git_pull_requests p ON p.organization_id=gl.organization_id AND p.id=gl.pull_request_id
    JOIN cloud_git_repositories gr ON gr.organization_id=p.organization_id AND gr.id=p.repository_id
    WHERE gl.organization_id=i.organization_id AND gl.issue_id=i.id
    ORDER BY ${pullRequestStageOrder},p.updated_at DESC LIMIT 1) AS "pullRequest",
  (SELECT jsonb_build_object('id',pi.id,'identifier',pi.identifier,'title',pi.title)
    FROM cloud_issue_relations pr JOIN cloud_issues pi ON pi.organization_id=pr.organization_id AND pi.id=pr.source_id
    JOIN cloud_teams pt ON pt.organization_id=pi.organization_id AND pt.id=pi.team_id
    WHERE pr.organization_id=i.organization_id AND pr.kind='parent' AND pr.target_id=i.id AND pr.removed_at IS NULL
    AND cloud_team_visible(pt.organization_id,pt.id,pt.visibility,m.user_id)) AS parent`;

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
const slaDue = "cloud_issue_sla_due(i.organization_id,i.id)";
const slaPredicates: Record<SlaState, string> = {
  breached: `${slaDue}<=clock_timestamp()`,
  at_risk: `${slaDue} BETWEEN clock_timestamp() AND clock_timestamp()+interval '${slaAtRiskHours} hours'`,
  ok: `${slaDue}>clock_timestamp()+interval '${slaAtRiskHours} hours'`,
  none: `${slaDue} IS NULL`,
};
const dateColumns: Partial<Record<IssueFilterField, string>> = {
  due: "i.due_on",
  created: "i.created_at",
  updated: "i.updated_at",
};
const issueCreator =
  "(SELECT h.actor_id FROM cloud_issue_history h WHERE h.organization_id=i.organization_id AND h.issue_id=i.id ORDER BY h.revision LIMIT 1)";
const issueAutomation =
  "(SELECT h.automation FROM cloud_issue_history h WHERE h.organization_id=i.organization_id AND h.issue_id=i.id ORDER BY h.revision LIMIT 1)";
const openStates = "o.state NOT IN ('complete','canceled')";

function relatedIssue(
  kind: string,
  own: "source_id" | "target_id",
  other: "source_id" | "target_id",
  extra = "",
): string {
  return `EXISTS (SELECT 1 FROM cloud_issue_relations r JOIN cloud_issues o ON o.organization_id=r.organization_id AND o.id=r.${other}
    JOIN cloud_teams ot ON ot.organization_id=o.organization_id AND ot.id=o.team_id
    WHERE r.organization_id=i.organization_id AND r.${own}=i.id AND r.kind='${kind}' AND r.removed_at IS NULL
    AND cloud_team_visible(ot.organization_id,ot.id,ot.visibility,$2)${extra})`;
}

const flagPredicates: Partial<Record<IssueFilterField, string>> = {
  blocked: relatedIssue(
    "blocks",
    "target_id",
    "source_id",
    ` AND ${openStates}`,
  ),
  blocking: relatedIssue(
    "blocks",
    "source_id",
    "target_id",
    ` AND ${openStates}`,
  ),
  hasParent: relatedIssue("parent", "target_id", "source_id"),
  hasSubIssues: relatedIssue("parent", "source_id", "target_id"),
  duplicate: relatedIssue("duplicate", "source_id", "target_id"),
  automated: `${issueAutomation} IS NOT NULL`,
};

function teamCycle(status: string, order: string): string {
  return `i.cycle_id=(SELECT c.id FROM cloud_cycles c WHERE c.organization_id=i.organization_id AND c.team_id=i.team_id AND c.status='${status}' ORDER BY ${order},c.id LIMIT 1)`;
}

const cyclePredicates: Record<string, string> = {
  current: teamCycle("active", "c.starts_on"),
  upcoming: teamCycle("planned", "c.starts_on"),
  previous: teamCycle("closed", "c.ends_on DESC"),
};

function datePredicate(
  column: string,
  condition: IssueFilterCondition,
  bind: (value: unknown) => string,
): string {
  const value = condition.values[0];
  switch (condition.operator) {
    case "before":
      return `${column}<${bind(value)}::date`;
    case "after":
      return `${column}>=${bind(value)}::date+1`;
    default:
      return column === "i.due_on"
        ? `i.due_on BETWEEN CURRENT_DATE AND CURRENT_DATE+${bind(Number(value))}::int`
        : `${column}>=clock_timestamp()-make_interval(days => ${bind(Number(value))}::int)`;
  }
}

function conditionPredicate(
  actor: CloudActor,
  condition: IssueFilterCondition,
  bind: (value: unknown) => string,
): string {
  if (condition.operator === "empty")
    return conditionPredicate(
      actor,
      { field: condition.field, negated: false, values: [noneFilterValue] },
      bind,
    );
  const dateColumn = dateColumns[condition.field];
  if (
    dateColumn &&
    (condition.operator === "before" ||
      condition.operator === "after" ||
      condition.operator === "within")
  )
    return datePredicate(dateColumn, condition, bind);
  const flagPredicate = flagPredicates[condition.field];
  if (flagPredicate) return flagPredicate;
  const ids = condition.values
    .filter(
      (value) =>
        value !== noneFilterValue &&
        value !== aiFilterValue &&
        !Object.hasOwn(cyclePredicates, value),
    )
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
  const labelExists = (filter: string) =>
    `EXISTS (SELECT 1 FROM cloud_issue_labels a WHERE a.organization_id=i.organization_id AND a.issue_id=i.id${filter})`;
  switch (condition.field) {
    case "status":
      return reference("i.status_id");
    case "assignee":
      return anyOf(
        ids.length > 0 && `i.assignee_id=ANY(${bind(ids)}::uuid[])`,
        none && "(i.assignee_id IS NULL AND NOT i.ai_assigned)",
        condition.values.includes(aiFilterValue) && "i.ai_assigned",
      );
    case "delegate":
      return anyOf(
        ids.length > 0 && `i.ai_assigned_by=ANY(${bind(ids)}::uuid[])`,
        none && "NOT i.ai_assigned",
        condition.values.includes(aiFilterValue) && "i.ai_assigned",
      );
    case "creator":
      return reference(issueCreator);
    case "priority":
      return `i.priority=ANY(${bind(condition.values)}::text[])`;
    case "project":
      return reference("i.project_id");
    case "team":
      return reference("i.team_id");
    case "milestone":
      return reference("i.milestone_id");
    case "initiative":
      return anyOf(
        ids.length > 0 &&
          `EXISTS (SELECT 1 FROM cloud_initiative_projects ip WHERE ip.organization_id=i.organization_id AND ip.project_id=i.project_id AND ip.initiative_id=ANY(${bind(ids)}::uuid[]))`,
        none &&
          "NOT EXISTS (SELECT 1 FROM cloud_initiative_projects ip WHERE ip.organization_id=i.organization_id AND ip.project_id=i.project_id)",
      );
    case "releasedIn": {
      const released = (filter: string) =>
        `EXISTS (SELECT 1 FROM cloud_pipeline_release_issues ri JOIN cloud_pipeline_releases pr ON pr.organization_id=ri.organization_id AND pr.id=ri.release_id
          WHERE ri.organization_id=i.organization_id AND ri.issue_id=i.id AND NOT ri.excluded${filter})`;
      return anyOf(
        ids.length > 0 &&
          released(
            ` AND (pr.pipeline_id=ANY(${bind(ids)}::uuid[]) OR pr.id=ANY(${bind(ids)}::uuid[]))`,
          ),
        none && `NOT ${released("")}`,
      );
    }
    case "cycle":
      return anyOf(reference("i.cycle_id"), mapped(cyclePredicates));
    case "label":
      if (condition.operator === "all")
        return ids
          .map((id) => labelExists(` AND a.label_id=${bind(id)}::uuid`))
          .join(" AND ");
      return anyOf(
        ids.length > 0 &&
          labelExists(` AND a.label_id=ANY(${bind(ids)}::uuid[])`),
        none && `NOT ${labelExists("")}`,
      );
    case "estimate": {
      const exact = condition.values.filter(
        (value) => !Object.hasOwn(estimatePredicates, value),
      );
      return anyOf(
        mapped(estimatePredicates),
        exact.length > 0 && `i.estimate=ANY(${bind(exact)}::text[])`,
      );
    }
    case "due":
      return mapped(duePredicates);
    case "sla":
      return mapped(slaPredicates);
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
          `EXISTS (SELECT 1 FROM cloud_git_pull_request_issues gl JOIN cloud_git_pull_requests p ON p.organization_id=gl.organization_id AND p.id=gl.pull_request_id
          WHERE gl.organization_id=i.organization_id AND gl.issue_id=i.id AND p.stage=ANY(${bind(stages)}::text[]))`,
        none &&
          "NOT EXISTS (SELECT 1 FROM cloud_git_pull_request_issues gl WHERE gl.organization_id=i.organization_id AND gl.issue_id=i.id)",
      );
    }
    default:
      return "";
  }
}

function conditionClause(
  actor: CloudActor,
  condition: IssueFilterCondition,
  bind: (value: unknown) => string,
): string | null {
  const predicate = conditionPredicate(actor, condition, bind);
  if (!predicate) return null;
  return `${condition.negated ? "NOT " : ""}COALESCE((${predicate}),false)`;
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
    const clause = conditionClause(actor, condition, bind);
    if (clause) clauses.push(clause);
  }
  for (const group of filters.groups ?? []) {
    const members = group
      .map((condition) => conditionClause(actor, condition, bind))
      .filter((clause) => clause !== null);
    if (members.length) clauses.push(`(${members.join(" OR ")})`);
  }
  return { where: clauses.join(" AND "), parameters };
}
export const projectColumns = `id,team_id AS "teamId",name,description,status,status_id AS "statusId",
  (SELECT s.name FROM cloud_project_statuses s WHERE s.organization_id=cloud_projects.organization_id AND s.id=cloud_projects.status_id) AS "statusName",
  update_cadence AS "updateCadence",lead_id AS "leadId",to_char(starts_on,'YYYY-MM-DD') AS "startsOn",to_char(target_on,'YYYY-MM-DD') AS "targetOn",revision`;
