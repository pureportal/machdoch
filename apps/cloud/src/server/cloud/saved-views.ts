import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  SavedView,
  SavedViewInput,
} from "../../lib/cloud-view-contract";
import { CloudError, command, requireMembership } from "./access";
import type { CloudDatabase } from "./database";

const maximumViewsPerUser = 50;

export class CloudSavedViews {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<SavedView[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<SavedView & Record<string, unknown>>(
          `SELECT id,name,filters,shared,user_id=$2 AS owned FROM cloud_saved_views
           WHERE organization_id=$1 AND (user_id=$2 OR shared) ORDER BY lower(name),id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: SavedViewInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, input.shared ? "write" : "read");
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
            "INSERT INTO cloud_saved_views (organization_id,id,user_id,name,filters,shared) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              actor.organizationId,
              id,
              actor.userId,
              input.name,
              JSON.stringify(input.filters),
              input.shared,
            ],
          );
          return { id };
        },
      );
    });
  }

  remove(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      const role = await requireMembership(sql, actor);
      const view = (
        await sql.query<{ user_id: string; shared: boolean }>(
          "SELECT user_id,shared FROM cloud_saved_views WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!view || (view.user_id !== actor.userId && !view.shared))
        throw new CloudError(404, "not_found", "View is unavailable.");
      if (view.user_id !== actor.userId && !["owner", "admin"].includes(role))
        throw new CloudError(
          403,
          "permission_denied",
          "Only its owner or an administrator can remove a shared view.",
        );
      await sql.query(
        "DELETE FROM cloud_saved_views WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }
}
