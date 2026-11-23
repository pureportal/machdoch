import type { CloudActor } from "../../lib/cloud-contract";
import {
  isSettingKey,
  parseSettingValue,
  type SettingKey,
  type SettingScope,
  type SettingValue,
} from "../../lib/cloud-settings-contract";
import {
  CloudError,
  command,
  requireMembership,
  requireTeam,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";

type StoredSettings<Scope extends SettingScope> = Partial<{
  [Key in SettingKey<Scope>]: SettingValue<Scope, Key>;
}>;

function requireKey<Scope extends SettingScope>(
  scope: Scope,
  key: string,
): SettingKey<Scope> {
  if (!isSettingKey(scope, key))
    throw new CloudError(422, "setting_unknown", "Choose a known setting.");
  return key;
}

function collect<Scope extends SettingScope>(
  scope: Scope,
  rows: { key: string; value: unknown }[],
): StoredSettings<Scope> {
  const settings: Record<string, unknown> = {};
  for (const row of rows)
    if (isSettingKey(scope, row.key))
      settings[row.key] = parseSettingValue(scope, row.key, row.value);
  return settings as StoredSettings<Scope>;
}

export async function readUserSettings(
  sql: CloudSql,
  actor: CloudActor,
): Promise<StoredSettings<"user">> {
  const rows = await sql.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM cloud_user_settings WHERE organization_id=$1 AND user_id=$2",
    [actor.organizationId, actor.userId],
  );
  return collect("user", rows.rows);
}

export async function readOrganizationSettings(
  sql: CloudSql,
  organizationId: string,
): Promise<StoredSettings<"organization">> {
  const rows = await sql.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM cloud_organization_settings WHERE organization_id=$1",
    [organizationId],
  );
  return collect("organization", rows.rows);
}

export async function readTeamSettings(
  sql: CloudSql,
  organizationId: string,
  teamId: string,
): Promise<StoredSettings<"team">> {
  const rows = await sql.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM cloud_team_settings WHERE organization_id=$1 AND team_id=$2",
    [organizationId, teamId],
  );
  return collect("team", rows.rows);
}

export class CloudSettingsStore {
  constructor(private readonly database: CloudDatabase) {}

  personal(actor: CloudActor): Promise<StoredSettings<"user">> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return readUserSettings(sql, actor);
    });
  }

  organization(actor: CloudActor): Promise<StoredSettings<"organization">> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return readOrganizationSettings(sql, actor.organizationId);
    });
  }

  team(actor: CloudActor, teamId: string): Promise<StoredSettings<"team">> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId);
      return readTeamSettings(sql, actor.organizationId, teamId);
    });
  }

  async setPersonal(
    actor: CloudActor,
    commandId: string,
    key: string,
    value: unknown,
  ): Promise<{ key: string; value: unknown }> {
    const settingKey = requireKey("user", key);
    const parsed = parseSettingValue("user", settingKey, value);
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return command(
        sql,
        actor,
        commandId,
        { kind: "settings.user", key, value: parsed },
        async () => {
          await sql.query(
            `INSERT INTO cloud_user_settings (organization_id,user_id,key,value) VALUES ($1,$2,$3,$4)
            ON CONFLICT (organization_id,user_id,key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp()`,
            [actor.organizationId, actor.userId, key, JSON.stringify(parsed)],
          );
          return { key, value: parsed };
        },
      );
    });
  }

  async setOrganization(
    actor: CloudActor,
    commandId: string,
    key: string,
    value: unknown,
  ): Promise<{ key: string; value: unknown }> {
    const settingKey = requireKey("organization", key);
    const parsed = parseSettingValue("organization", settingKey, value);
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      return command(
        sql,
        actor,
        commandId,
        { kind: "settings.organization", key, value: parsed },
        async () => {
          await sql.query(
            `INSERT INTO cloud_organization_settings (organization_id,key,value,updated_by) VALUES ($1,$2,$3,$4)
            ON CONFLICT (organization_id,key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
            [actor.organizationId, key, JSON.stringify(parsed), actor.userId],
          );
          return { key, value: parsed };
        },
      );
    });
  }

  async setTeam(
    actor: CloudActor,
    commandId: string,
    teamId: string,
    key: string,
    value: unknown,
  ): Promise<{ key: string; value: unknown }> {
    const settingKey = requireKey("team", key);
    const parsed = parseSettingValue("team", settingKey, value);
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId, "teams.manage");
      return command(
        sql,
        actor,
        commandId,
        { kind: "settings.team", teamId, key, value: parsed },
        async () => {
          await sql.query(
            `INSERT INTO cloud_team_settings (organization_id,team_id,key,value,updated_by) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (organization_id,team_id,key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
            [
              actor.organizationId,
              teamId,
              key,
              JSON.stringify(parsed),
              actor.userId,
            ],
          );
          return { key, value: parsed };
        },
      );
    });
  }
}
