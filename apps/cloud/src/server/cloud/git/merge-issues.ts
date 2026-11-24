import { issueInputSchema, type CloudActor } from "../../../lib/cloud-contract";
import { requireTeam } from "../access";
import type { CloudSql } from "../database";
import { createIssueInTransaction } from "../planning";
import {
  automationSteps,
  linkedIssueSelect,
  type AutomationStep,
  type LinkedIssue,
} from "./status-steps";

export interface MergedPullRequest {
  id: string;
  title: string;
  number: number;
  fullName: string;
  teamId: string;
}

export async function unlinkedMergedPullRequest(
  sql: CloudSql,
  organizationId: string,
  pullRequestId: string,
): Promise<MergedPullRequest | null> {
  return (
    (
      await sql.query<MergedPullRequest & Record<string, unknown>>(
        `SELECT p.id,p.title,p.number,r.full_name AS "fullName",r.team_id AS "teamId"
        FROM cloud_git_pull_requests p JOIN cloud_git_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
        WHERE p.organization_id=$1 AND p.id=$2 AND p.state='merged' AND r.team_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cloud_git_pull_request_issues l WHERE l.organization_id=p.organization_id AND l.pull_request_id=p.id)`,
        [organizationId, pullRequestId],
      )
    ).rows[0] ?? null
  );
}

async function openIssueWithTitle(
  sql: CloudSql,
  organizationId: string,
  teamId: string,
  title: string,
): Promise<string | null> {
  return (
    (
      await sql.query<{ id: string }>(
        `SELECT i.id FROM cloud_issues i JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
        WHERE i.organization_id=$1 AND i.team_id=$2 AND lower(i.title)=lower($3) AND NOT i.archived AND s.category NOT IN ('completed','canceled')
        ORDER BY i.created_at DESC LIMIT 1`,
        [organizationId, teamId, title],
      )
    ).rows[0]?.id ?? null
  );
}

export async function recordMergedWork(
  sql: CloudSql,
  actor: CloudActor,
  pullRequest: MergedPullRequest,
): Promise<{ issueId: string; steps: AutomationStep[] }> {
  const team = await requireTeam(sql, actor, pullRequest.teamId, "issues.edit");
  const title = pullRequest.title.trim().slice(0, 300);
  const issueId =
    (await openIssueWithTitle(sql, actor.organizationId, team.id, title)) ??
    (
      await createIssueInTransaction(
        sql,
        actor,
        team,
        issueInputSchema.parse({ teamId: team.id, title }),
      )
    ).id;
  await sql.query(
    "INSERT INTO cloud_git_pull_request_issues (organization_id,pull_request_id,issue_id,closes,recorded) VALUES ($1,$2,$3,true,true) ON CONFLICT DO NOTHING",
    [actor.organizationId, pullRequest.id, issueId],
  );
  await sql.query(
    "DELETE FROM cloud_git_issue_suggestions WHERE organization_id=$1 AND pull_request_id=$2",
    [actor.organizationId, pullRequest.id],
  );
  const issue = (
    await sql.query<LinkedIssue>(
      `${linkedIssueSelect} WHERE i.organization_id=$1 AND i.id=$2`,
      [actor.organizationId, issueId],
    )
  ).rows[0]!;
  return {
    issueId,
    steps: await automationSteps(
      sql,
      actor.organizationId,
      pullRequest.id,
      `${pullRequest.fullName}#${pullRequest.number}`,
      "merged",
      [{ ...issue, completes: !issue.completes_on_release }],
    ),
  };
}
