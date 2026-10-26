import type { RunManifest } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudSql } from "../database";
import { issuePlanningState } from "../issue-graph";

export async function runPlanningChanged(
  sql: CloudSql,
  organizationId: string,
  run: { manifest: RunManifest; planningDigest: string | null },
): Promise<boolean> {
  const subject = run.manifest.subject;
  if (subject.kind === "project") {
    const project = (
      await sql.query<{ revision: number }>(
        "SELECT revision FROM cloud_projects WHERE organization_id=$1 AND id=$2",
        [organizationId, subject.id],
      )
    ).rows[0];
    return project?.revision !== subject.revision;
  }
  const issue = (
    await sql.query<{ revision: number; archived: boolean; state: string }>(
      "SELECT revision,archived,state FROM cloud_issues WHERE organization_id=$1 AND id=$2",
      [organizationId, subject.id],
    )
  ).rows[0];
  if (
    !issue ||
    issue.revision !== subject.revision ||
    issue.archived ||
    ["complete", "canceled"].includes(issue.state)
  )
    return true;
  const planning = await issuePlanningState(sql, organizationId, subject.id);
  return !planning.ready || planning.digest !== run.planningDigest;
}
