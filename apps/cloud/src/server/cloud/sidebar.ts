import type { CloudActor } from "../../lib/cloud-contract";
import {
  defaultSidebarPreferences,
  sidebarPreferencesSchema,
  type SidebarPreferences,
} from "../../lib/cloud-sidebar-contract";
import { command, requireMembership } from "./access";
import type { CloudDatabase } from "./database";

export class CloudSidebar {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor): Promise<SidebarPreferences> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const stored = (
        await sql.query<{ preferences: unknown }>(
          "SELECT preferences FROM cloud_sidebar_preferences WHERE organization_id=$1 AND user_id=$2",
          [actor.organizationId, actor.userId],
        )
      ).rows[0];
      return stored
        ? sidebarPreferencesSchema.parse(stored.preferences)
        : defaultSidebarPreferences;
    });
  }

  update(
    actor: CloudActor,
    commandId: string,
    preferences: SidebarPreferences,
  ): Promise<SidebarPreferences> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return command(
        sql,
        actor,
        commandId,
        { kind: "sidebar.update", preferences },
        async () => {
          await sql.query(
            `INSERT INTO cloud_sidebar_preferences (organization_id,user_id,preferences) VALUES ($1,$2,$3)
            ON CONFLICT (organization_id,user_id) DO UPDATE SET preferences=excluded.preferences,updated_at=clock_timestamp()`,
            [actor.organizationId, actor.userId, JSON.stringify(preferences)],
          );
          return preferences;
        },
      );
    });
  }
}
