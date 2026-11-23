import type { CloudActor } from "../../lib/cloud-contract";
import { CloudError, requireTeam } from "./access";
import type { CloudSql } from "./database";

export async function requireTeamParent(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string | null,
  parentId: string,
): Promise<void> {
  if (parentId === teamId)
    throw new CloudError(422, "team_cycle", "A team cannot contain itself.");
  await requireTeam(sql, actor, parentId, "teams.manage");
  if (!teamId) return;
  const cycle = await sql.query(
    `WITH RECURSIVE ancestors(id) AS (
      SELECT parent_team_id FROM cloud_teams WHERE organization_id=$1 AND id=$2
      UNION SELECT t.parent_team_id FROM cloud_teams t JOIN ancestors a ON t.id=a.id WHERE t.organization_id=$1
    ) SELECT 1 FROM ancestors WHERE id=$3`,
    [actor.organizationId, parentId, teamId],
  );
  if (cycle.rows.length)
    throw new CloudError(
      422,
      "team_cycle",
      "A team cannot sit inside one of its own sub-teams.",
    );
}
