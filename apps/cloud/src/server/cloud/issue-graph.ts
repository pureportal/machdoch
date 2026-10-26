import { createHash, randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import { CloudError, recordEvent } from "./access";
import type { CloudSql } from "./database";

export async function insertIssueRelation(
  sql: CloudSql,
  actor: CloudActor,
  kind: "parent" | "blocks" | "related",
  sourceId: string,
  targetId: string,
): Promise<{ id: string }> {
  if (sourceId === targetId)
    throw new CloudError(422, "relation_self", "Choose a different issue.");
  if (kind === "related" && sourceId > targetId)
    [sourceId, targetId] = [targetId, sourceId];
  const existing = (
    await sql.query<{ id: string }>(
      "SELECT id FROM cloud_issue_relations WHERE organization_id=$1 AND kind=$2 AND source_id=$3 AND target_id=$4 AND removed_at IS NULL",
      [actor.organizationId, kind, sourceId, targetId],
    )
  ).rows[0];
  if (existing) return existing;
  if (
    kind === "parent" &&
    (
      await sql.query(
        "SELECT id FROM cloud_issue_relations WHERE organization_id=$1 AND kind='parent' AND target_id=$2 AND removed_at IS NULL",
        [actor.organizationId, targetId],
      )
    ).rows.length
  )
    throw new CloudError(
      409,
      "relation_parent",
      "This change is unavailable. Review the issue's parent with a team administrator.",
    );
  const full = (
    await sql.query(
      `SELECT endpoint FROM (
      SELECT source_id AS endpoint FROM cloud_issue_relations WHERE organization_id=$1 AND removed_at IS NULL AND source_id=ANY($2::uuid[])
      UNION ALL SELECT target_id FROM cloud_issue_relations WHERE organization_id=$1 AND removed_at IS NULL AND target_id=ANY($2::uuid[])
    ) edges GROUP BY endpoint HAVING count(*) >= 1000`,
      [actor.organizationId, [sourceId, targetId]],
    )
  ).rows.length;
  if (full)
    throw new CloudError(
      409,
      "relation_capacity",
      "This change is unavailable. Review existing links with a team administrator.",
    );
  if (kind !== "related") {
    const reachable = (
      await sql.query<{ id: string }>(
        `WITH RECURSIVE reachable(id) AS (
        SELECT $3::uuid UNION SELECT r.target_id FROM reachable n CROSS JOIN LATERAL (
          SELECT target_id FROM cloud_issue_relations WHERE organization_id=$1 AND source_id=n.id AND kind=$2 AND removed_at IS NULL OFFSET 0
        ) r
      ) SELECT id FROM reachable LIMIT 10001`,
        [actor.organizationId, kind, targetId],
      )
    ).rows;
    if (
      reachable.length > 10000 ||
      reachable.some((row) => row.id === sourceId)
    )
      throw new CloudError(
        409,
        "relation_cycle",
        "These issues cannot be linked in this direction. Review their relationships with a team administrator.",
      );
  }
  const id = randomUUID();
  await sql.query(
    "INSERT INTO cloud_issue_relations (organization_id,id,kind,source_id,target_id,actor_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [actor.organizationId, id, kind, sourceId, targetId, actor.userId],
  );
  await recordIssueRelation(sql, actor, id, sourceId, targetId, false);
  return { id };
}

export async function recordIssueRelation(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  sourceId: string,
  targetId: string,
  removed: boolean,
): Promise<void> {
  await sql.query(
    `INSERT INTO cloud_issue_relation_versions (organization_id,issue_id,version) VALUES ($1,$2,$4),($1,$3,$4)
    ON CONFLICT (organization_id,issue_id) DO UPDATE SET version=excluded.version`,
    [actor.organizationId, sourceId, targetId, randomUUID()],
  );
  await recordEvent(
    sql,
    actor,
    removed ? "issue.relation_removed" : "issue.relation_added",
    id,
    removed ? 2 : 1,
    { sourceId, targetId },
  );
}

export async function issuePlanningState(
  sql: CloudSql,
  organizationId: string,
  issueId: string,
): Promise<{ digest: string; ready: boolean }> {
  const version =
    (
      await sql.query<{ version: string }>(
        "SELECT version FROM cloud_issue_relation_versions WHERE organization_id=$1 AND issue_id=$2",
        [organizationId, issueId],
      )
    ).rows[0]?.version ?? null;
  const rows = (
    await sql.query<{
      id: string;
      kind: string;
      source: string;
      target: string;
      blockerRevision: number | null;
      blockerState: string | null;
    }>(
      `SELECT r.id,r.kind,r.source_id AS source,r.target_id AS target,
      b.revision AS "blockerRevision",b.state AS "blockerState"
    FROM cloud_issue_relations r LEFT JOIN cloud_issues b ON b.organization_id=r.organization_id AND b.id=r.source_id AND r.kind='blocks' AND r.target_id=$2
    WHERE r.organization_id=$1 AND r.removed_at IS NULL AND (r.source_id=$2 OR r.target_id=$2) ORDER BY r.id`,
      [organizationId, issueId],
    )
  ).rows;
  return {
    digest: createHash("sha256")
      .update(JSON.stringify([version, rows]))
      .digest("hex"),
    ready: rows.every(
      (row) => row.blockerState === null || row.blockerState === "complete",
    ),
  };
}
