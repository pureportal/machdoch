import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import {
  maximumTeamResources,
  type CloudTeamHome,
  type TeamResource,
  type TeamResourceInput,
} from "../../lib/cloud-team-contract";
import { CloudError, command, requireTeam } from "./access";
import type { CloudDatabase } from "./database";

const resourceColumns = `id,title,url,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

export class CloudTeamHomes {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor, teamId: string): Promise<CloudTeamHome> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId);
      const [members, resources] = await Promise.all([
        sql.query<{ user_id: string }>(
          `SELECT tm.user_id FROM cloud_team_memberships tm
          JOIN cloud_memberships m ON m.organization_id=tm.organization_id AND m.user_id=tm.user_id AND m.active
          WHERE tm.organization_id=$1 AND tm.team_id=$2`,
          [actor.organizationId, teamId],
        ),
        sql.query<TeamResource & Record<string, unknown>>(
          `SELECT ${resourceColumns} FROM cloud_team_resources WHERE organization_id=$1 AND team_id=$2 ORDER BY created_at,id`,
          [actor.organizationId, teamId],
        ),
      ]);
      return {
        memberIds: members.rows.map((row) => row.user_id),
        resources: resources.rows,
      };
    });
  }

  addResource(
    actor: CloudActor,
    key: string,
    teamId: string,
    input: TeamResourceInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId, "planning.edit");
      return command(
        sql,
        actor,
        key,
        { kind: "team.resource.add", teamId, input },
        async () => {
          const count = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM cloud_team_resources WHERE organization_id=$1 AND team_id=$2",
              [actor.organizationId, teamId],
            )
          ).rows[0]!.count;
          if (count >= maximumTeamResources)
            throw new CloudError(
              409,
              "resource_limit",
              `Remove a resource before adding more than ${maximumTeamResources}.`,
            );
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_team_resources (organization_id,id,team_id,title,url,created_by) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              actor.organizationId,
              id,
              teamId,
              input.title,
              input.url,
              actor.userId,
            ],
          );
          return { id };
        },
      );
    });
  }

  removeResource(
    actor: CloudActor,
    teamId: string,
    resourceId: string,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId, "planning.edit");
      await sql.query(
        "DELETE FROM cloud_team_resources WHERE organization_id=$1 AND team_id=$2 AND id=$3",
        [actor.organizationId, teamId, resourceId],
      );
    });
  }
}
