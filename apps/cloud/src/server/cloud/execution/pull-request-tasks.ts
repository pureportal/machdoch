import type { PullRequestTask } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudActor } from "../../../lib/cloud-contract";
import { teamVisibility } from "../access";
import type { CloudSql } from "../database";

export const sandboxStatusContext = "machdoch/sandbox";

export async function pullRequestProfileId(
  sql: CloudSql,
  actor: CloudActor,
  pullRequestId: string,
): Promise<string | null> {
  return (
    (
      await sql.query<{ id: string }>(
        `SELECT p.id FROM cloud_execution_profiles p
        JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
        JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
        JOIN cloud_git_pull_requests pr ON pr.organization_id=p.organization_id AND pr.id=$3
        JOIN cloud_git_repositories r ON r.organization_id=pr.organization_id AND r.id=pr.repository_id
        WHERE p.organization_id=$1 AND p.enabled AND ${teamVisibility}
        AND lower(regexp_replace(p.definition->>'repository','[.]git$',''))=lower(regexp_replace(r.web_url,'[.]git$',''))
        ORDER BY p.name,p.id LIMIT 1`,
        [actor.organizationId, actor.userId, pullRequestId],
      )
    ).rows[0]?.id ?? null
  );
}

export const pullRequestTaskDefaults: Record<
  PullRequestTask,
  { objective: string; acceptanceCriteria: string }
> = {
  check: {
    objective:
      "Check this pull request before it is merged. Install what it needs, build it and run its tests and checks. Read the changed code and look for bugs, regressions, security problems, broken edge cases and missing tests. If it changes a user interface and a browser is available in the sandbox, start the app and inspect the affected screens for visual problems. Do not fix anything; report what you find.",
    acceptanceCriteria:
      "Every problem is reported with the file, the evidence and why it matters. Commands that could not run are reported as not run.",
  },
  fix: {
    objective:
      "Fix the failing checks and address the review comments on this pull request.",
    acceptanceCriteria:
      "The checks pass and every review comment is addressed.",
  },
  resolve: {
    objective:
      "The base branch was merged into this pull request's working tree and left conflicts. Resolve every conflict so both sides' intent is kept, remove all conflict markers, and make the project build and its tests pass.",
    acceptanceCriteria:
      "No conflict markers remain, the base branch's changes are kept, and the checks pass.",
  },
};
