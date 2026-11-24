import { commitReferences } from "../../../lib/git-links";
import type { CloudSql } from "../database";
import type { StoredRepository } from "./events";
import { gitReviewSettings } from "./review-settings";
import {
  automationSteps,
  linkedIssueSelect,
  type AutomationStep,
  type LinkedIssue,
} from "./status-steps";
import type { WebhookActivity } from "./webhook-payloads";

const commitSha = /^[0-9a-f]{40}$/u;

export async function linkPushedCommits(
  sql: CloudSql,
  connection: { organizationId: string; automate: boolean },
  repository: StoredRepository,
  activities: WebhookActivity[],
): Promise<AutomationStep[]> {
  const organizationId = connection.organizationId;
  const pushes = activities.filter(
    (activity) => activity.kind === "push" && activity.push?.commits.length,
  );
  if (!pushes.length) return [];
  if (!(await gitReviewSettings(sql, organizationId)).commitLinks) return [];
  const keys = (
    await sql.query<{ key: string }>(
      "SELECT key FROM cloud_teams WHERE organization_id=$1",
      [organizationId],
    )
  ).rows.map((row) => row.key);
  const steps: AutomationStep[] = [];
  for (const activity of pushes) {
    const onDefaultBranch = activity.branch === repository.defaultBranch;
    for (const commit of activity.push!.commits) {
      if (!commitSha.test(commit.id)) continue;
      const references = commitReferences(commit.message, keys);
      if (!references.length) continue;
      const issues = (
        await sql.query<LinkedIssue>(
          `${linkedIssueSelect} WHERE i.organization_id=$1 AND i.identifier=ANY($2::text[])`,
          [organizationId, references.map((entry) => entry.identifier)],
        )
      ).rows;
      for (const issue of issues) {
        const closes = references.some(
          (entry) => entry.identifier === issue.identifier && entry.closes,
        );
        await sql.query(
          `INSERT INTO cloud_git_commit_issues (organization_id,repository_id,sha,issue_id,closes,message,author)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [
            organizationId,
            repository.id,
            commit.id,
            issue.id,
            closes,
            commit.message,
            commit.author,
          ],
        );
        if (
          !closes ||
          !onDefaultBranch ||
          !connection.automate ||
          issue.completes_on_release
        )
          continue;
        const completed = await sql.query(
          "UPDATE cloud_git_commit_issues SET completed=true WHERE organization_id=$1 AND repository_id=$2 AND sha=$3 AND issue_id=$4 AND NOT completed RETURNING sha",
          [organizationId, repository.id, commit.id, issue.id],
        );
        if (!completed.rows.length) continue;
        steps.push(
          ...(await automationSteps(
            sql,
            organizationId,
            `${repository.id}:${commit.id}`,
            `${repository.fullName}@${commit.id.slice(0, 7)}`,
            "merged",
            [{ ...issue, completes: true }],
          )),
        );
      }
    }
  }
  return steps;
}
