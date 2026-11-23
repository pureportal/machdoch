import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import {
  maximumPinnedViews,
  type SavedView,
  type SavedViewInput,
} from "../../lib/cloud-view-contract";
import {
  accessCan,
  CloudError,
  command,
  requireMembership,
  requireTeam,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";

const maximumViewsPerUser = 50;

export function savedViewVisible(alias: string, userParameter: string): string {
  return `(${alias}.scope='workspace' OR (${alias}.scope='personal' AND ${alias}.user_id=${userParameter}) OR (${alias}.scope='team' AND EXISTS (SELECT 1 FROM cloud_teams vt WHERE vt.organization_id=${alias}.organization_id AND vt.id=${alias}.team_id AND cloud_team_visible(vt.organization_id,vt.id,vt.visibility,${userParameter}))))`;
}

const viewColumns = `v.id,v.name,v.description,v.icon,v.scope,v.team_id AS "teamId",v.filters,v.user_id=$2 AS owned`;

async function requireScope(
  sql: CloudSql,
  actor: CloudActor,
  input: SavedViewInput,
): Promise<void> {
  if (input.scope === "team")
    await requireTeam(sql, actor, input.teamId!, "issues.edit");
  else
    await requireMembership(
      sql,
      actor,
      input.scope === "workspace" ? "issues.edit" : undefined,
    );
}

function viewValues(input: SavedViewInput): unknown[] {
  return [
    input.name,
    input.description,
    input.icon,
    input.scope,
    input.teamId,
    JSON.stringify(input.filters),
  ];
}

export class CloudSavedViews {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<SavedView[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<SavedView & Record<string, unknown>>(
          `SELECT ${viewColumns} FROM cloud_saved_views v
           WHERE v.organization_id=$1 AND ${savedViewVisible("v", "$2")} ORDER BY lower(v.name),v.id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  pinned(actor: CloudActor, teamId: string): Promise<SavedView[]> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId);
      return (
        await sql.query<SavedView & Record<string, unknown>>(
          `SELECT ${viewColumns} FROM cloud_team_pinned_views p
           JOIN cloud_saved_views v ON v.organization_id=p.organization_id AND v.id=p.view_id
           WHERE p.organization_id=$1 AND p.team_id=$3 AND ${savedViewVisible("v", "$2")} ORDER BY p.position`,
          [actor.organizationId, actor.userId, teamId],
        )
      ).rows;
    });
  }

  pin(
    actor: CloudActor,
    key: string,
    teamId: string,
    viewIds: string[],
  ): Promise<{ viewIds: string[] }> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId, "issues.edit");
      return command(
        sql,
        actor,
        key,
        { kind: "view.pin", teamId, viewIds },
        async () => {
          const unique = [...new Set(viewIds)];
          if (unique.length > maximumPinnedViews)
            throw new CloudError(
              422,
              "pin_limit",
              `Pin at most ${maximumPinnedViews} views.`,
            );
          const pinnable = await sql.query<{ id: string }>(
            `SELECT id FROM cloud_saved_views WHERE organization_id=$1 AND id=ANY($2::uuid[])
             AND (scope='workspace' OR (scope='team' AND team_id=$3))`,
            [actor.organizationId, unique, teamId],
          );
          if (pinnable.rows.length !== unique.length)
            throw new CloudError(
              422,
              "view_not_pinnable",
              "Only team and workspace views can be pinned.",
            );
          await sql.query(
            "DELETE FROM cloud_team_pinned_views WHERE organization_id=$1 AND team_id=$2",
            [actor.organizationId, teamId],
          );
          for (const [position, viewId] of unique.entries())
            await sql.query(
              "INSERT INTO cloud_team_pinned_views (organization_id,team_id,view_id,position) VALUES ($1,$2,$3,$4)",
              [actor.organizationId, teamId, viewId, position],
            );
          return { viewIds: unique };
        },
      );
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: SavedViewInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireScope(sql, actor, input);
      return command(
        sql,
        actor,
        key,
        { kind: "view.create", input },
        async () => {
          const owned = await sql.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM cloud_saved_views WHERE organization_id=$1 AND user_id=$2",
            [actor.organizationId, actor.userId],
          );
          if (owned.rows[0]!.count >= maximumViewsPerUser)
            throw new CloudError(
              409,
              "view_limit",
              `Remove a view before saving more than ${maximumViewsPerUser}.`,
            );
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_saved_views (organization_id,id,user_id,name,description,icon,scope,team_id,filters) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [actor.organizationId, id, actor.userId, ...viewValues(input)],
          );
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: SavedViewInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireScope(sql, actor, input);
      return command(
        sql,
        actor,
        key,
        { kind: "view.update", id, input },
        async () => {
          const updated = await sql.query(
            "UPDATE cloud_saved_views SET name=$4,description=$5,icon=$6,scope=$7,team_id=$8,filters=$9 WHERE organization_id=$1 AND id=$2 AND user_id=$3 RETURNING id",
            [actor.organizationId, id, actor.userId, ...viewValues(input)],
          );
          if (!updated.rows.length)
            throw new CloudError(
              404,
              "not_found",
              "Only its owner can change this view.",
            );
          await sql.query(
            "DELETE FROM cloud_team_pinned_views WHERE organization_id=$1 AND view_id=$2 AND NOT coalesce($3::text='workspace' OR team_id=$4::uuid,false)",
            [actor.organizationId, id, input.scope, input.teamId],
          );
          return { id };
        },
      );
    });
  }

  remove(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      const access = await requireMembership(sql, actor);
      const view = (
        await sql.query<{ user_id: string }>(
          `SELECT v.user_id FROM cloud_saved_views v WHERE v.organization_id=$1 AND v.id=$3 AND ${savedViewVisible("v", "$2")} FOR UPDATE OF v`,
          [actor.organizationId, actor.userId, id],
        )
      ).rows[0];
      if (!view) throw new CloudError(404, "not_found", "View is unavailable.");
      if (view.user_id !== actor.userId && !accessCan(access, "teams.manage"))
        throw new CloudError(
          403,
          "permission_denied",
          "Only its owner or an administrator can remove a shared view.",
        );
      await sql.query(
        "DELETE FROM cloud_saved_views WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
      await sql.query(
        "DELETE FROM cloud_favorites WHERE organization_id=$1 AND kind='view' AND entity_id=$2",
        [actor.organizationId, id],
      );
    });
  }
}
