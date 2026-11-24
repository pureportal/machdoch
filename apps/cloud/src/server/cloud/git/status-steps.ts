import {
  automationTarget,
  type AutomationStatus,
  type GitStatusEvent,
} from "../../../lib/git-automation";
import { derivedCommandId } from "../command-ids";
import type { CloudSql } from "../database";

export type LinkedIssue = {
  id: string;
  identifier: string;
  team_id: string;
  status_id: string;
  category: AutomationStatus["category"];
  position: number;
  completes_on_release: boolean;
};

export const linkedIssueSelect = `SELECT i.id,i.identifier,i.team_id,s.id AS status_id,s.category,s.position,t.complete_issues_on_release AS completes_on_release FROM cloud_issues i
JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id`;

type TeamStatus = AutomationStatus & { team_id: string; revision: number };

export interface AutomationStep {
  issueId: string;
  status: { id: string; revision: number };
  key: string;
  reference: string;
}

export async function automationSteps(
  sql: CloudSql,
  organizationId: string,
  sourceId: string,
  reference: string,
  event: GitStatusEvent | null,
  issues: (LinkedIssue & { completes: boolean })[],
): Promise<AutomationStep[]> {
  if (!event || !issues.length) return [];
  const teamIds = [...new Set(issues.map((issue) => issue.team_id))];
  const statuses = (
    await sql.query<TeamStatus & Record<string, unknown>>(
      "SELECT id,team_id,category,position,archived,revision FROM cloud_workflow_statuses WHERE organization_id=$1 AND team_id=ANY($2::uuid[])",
      [organizationId, teamIds],
    )
  ).rows;
  const rules = new Map(
    (
      await sql.query<{ team_id: string; status_id: string | null }>(
        "SELECT team_id,status_id FROM cloud_git_status_rules WHERE organization_id=$1 AND team_id=ANY($2::uuid[]) AND event=$3",
        [organizationId, teamIds, event],
      )
    ).rows.map((row) => [row.team_id, row.status_id]),
  );
  return issues.flatMap((issue) => {
    if (event === "merged" && !issue.completes) return [];
    const team = statuses.filter((status) => status.team_id === issue.team_id);
    const target = automationTarget(event, rules.get(issue.team_id), team, {
      id: issue.status_id,
      category: issue.category,
      position: issue.position,
      archived: false,
    }) as TeamStatus | null;
    return target
      ? [
          {
            issueId: issue.id,
            status: { id: target.id, revision: target.revision },
            key: derivedCommandId(
              `${sourceId}:${event}`,
              `git-status:${issue.id}`,
            ),
            reference,
          },
        ]
      : [];
  });
}
