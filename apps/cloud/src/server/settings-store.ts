import { createId } from "./crypto";
import {
  type DatabaseRow,
  type FleetDatabase,
  optionalNumber,
  requiredNumber,
  requiredString,
} from "./database";
import type { SettingsCipher } from "./settings-crypto";
import type { ManagedSettingsDocument } from "./settings";

export type SettingsStoreErrorCode =
  | "not-found"
  | "revision-conflict"
  | "profile-limit"
  | "name-conflict";

export class SettingsStoreError extends Error {
  constructor(readonly code: SettingsStoreErrorCode) {
    super(code);
  }
}

export interface SettingsSecretSummary {
  secretId: string;
  lastFour: string;
  updatedAt: number;
}

export interface SettingsProfile {
  profileId: string;
  name: string;
  description: string;
  revision: number;
  document: ManagedSettingsDocument;
  secrets: SettingsSecretSummary[];
  createdAt: number;
  updatedAt: number;
}

export interface SettingsProfileSummary {
  profileId: string;
  name: string;
  description: string;
  revision: number;
  instructionCount: number;
  contextPackCount: number;
  promptCount: number;
  secretCount: number;
  assignmentCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SettingsProfileVersion {
  revision: number;
  name: string;
  description: string;
  changeSummary: string;
  createdAt: number;
}

export interface SettingsAssignment {
  instanceId: string;
  displayName: string;
  instanceStatus: "offline" | "revoked";
  profileId: string | null;
  profileName: string | null;
  profileRevision: number | null;
  assignedAt: number | null;
  lastAppliedRevision: number | null;
  lastAppliedAt: number | null;
  syncStatus: "unassigned" | "pending" | "applied" | "failed";
  lastSyncRevision: number | null;
  lastSyncAttemptAt: number | null;
  syncError: string | null;
}

export interface SettingsDelivery {
  profileId: string;
  name: string;
  revision: number;
  document: ManagedSettingsDocument;
  secrets: Record<string, string>;
}

export interface SettingsDeliveryIdentity {
  profileId: string;
  revision: number;
}

export class SettingsStore {
  constructor(private readonly database: FleetDatabase) {}

  async deliveryEnabled(): Promise<boolean> {
    return (
      (
        await this.database.get(
          "SELECT coalesce((remote_config#>>'{settingsManager,enabled}')::boolean,true) AS enabled FROM cloud_installation WHERE id=1",
        )
      )?.enabled === true
    );
  }

  async setDeliveryEnabled(enabled: boolean, now: number): Promise<void> {
    await this.database.transaction(async () => {
      await this.database.run(
        "UPDATE cloud_installation SET remote_config=remote_config || jsonb_build_object('settingsManager',coalesce(remote_config->'settingsManager','{}'::jsonb) || jsonb_build_object('enabled',$1::boolean)) WHERE id=1",
        enabled,
      );
      await this.database.audit(
        now,
        enabled ? "settings.delivery_enabled" : "settings.delivery_paused",
        null,
        "success",
      );
    });
  }

  async listProfiles(): Promise<SettingsProfileSummary[]> {
    return (
      await this.database.all(
        "SELECT p.profile_id, p.name, p.description, p.revision, p.document_json,\n                p.created_at, p.updated_at,\n                (SELECT COUNT(*)::integer FROM settings_secrets s WHERE s.profile_id = p.profile_id) AS secret_count,\n                (SELECT COUNT(*)::integer FROM settings_assignments a WHERE a.profile_id = p.profile_id) AS assignment_count\n         FROM settings_profiles p ORDER BY lower(p.name), p.created_at",
      )
    ).map((row) => {
      const document = parseDocument(requiredString(row, "document_json"));
      return {
        profileId: requiredString(row, "profile_id"),
        name: requiredString(row, "name"),
        description: requiredString(row, "description"),
        revision: requiredNumber(row, "revision"),
        instructionCount: document.instructions.length,
        contextPackCount: document.contextPacks.length,
        promptCount: document.prompts.length,
        secretCount: requiredNumber(row, "secret_count"),
        assignmentCount: requiredNumber(row, "assignment_count"),
        createdAt: requiredNumber(row, "created_at"),
        updatedAt: requiredNumber(row, "updated_at"),
      };
    });
  }

  async getProfile(profileId: string): Promise<SettingsProfile> {
    return await this.database.transaction(async () => {
      const row = await this.database.get(
        "SELECT profile_id, name, description, revision, document_json, created_at, updated_at\n       FROM settings_profiles WHERE profile_id = $1",
        profileId,
      );
      if (!row) throw new SettingsStoreError("not-found");
      const secrets = (
        await this.database.all(
          "SELECT secret_id, last_four, updated_at FROM settings_secrets\n         WHERE profile_id = $1 ORDER BY secret_id",
          profileId,
        )
      ).map((secret) => ({
        secretId: requiredString(secret, "secret_id"),
        lastFour: requiredString(secret, "last_four"),
        updatedAt: requiredNumber(secret, "updated_at"),
      }));
      return {
        profileId: requiredString(row, "profile_id"),
        name: requiredString(row, "name"),
        description: requiredString(row, "description"),
        revision: requiredNumber(row, "revision"),
        document: parseDocument(requiredString(row, "document_json")),
        secrets,
        createdAt: requiredNumber(row, "created_at"),
        updatedAt: requiredNumber(row, "updated_at"),
      };
    });
  }

  async createProfile(
    name: string,
    description: string,
    document: ManagedSettingsDocument,
    now: number,
    maximumProfiles: number,
  ): Promise<string> {
    return await this.database.transaction(async () => {
      const count = requiredNumber(
        await this.database.get(
          "SELECT COUNT(*)::integer AS count FROM settings_profiles",
        ),
        "count",
      );
      if (count >= maximumProfiles)
        throw new SettingsStoreError("profile-limit");
      const profileId = createId("profile");
      const serialized = JSON.stringify(document);
      try {
        await this.database.run(
          "INSERT INTO settings_profiles\n           (profile_id, name, description, revision, document_json, created_at, updated_at)\n           VALUES ($1, $2, $3, 1, $4, $5, $6)",
          profileId,
          name,
          description,
          serialized,
          now,
          now,
        );
      } catch (error) {
        mapNameConflict(error);
      }
      await this.insertVersion(
        profileId,
        1,
        name,
        description,
        serialized,
        "Created profile",
        now,
      );
      await this.database.audit(
        now,
        "settings_profile.created",
        profileId,
        "success",
      );
      return profileId;
    });
  }

  async updateProfile(
    profileId: string,
    expectedRevision: number,
    name: string,
    description: string,
    document: ManagedSettingsDocument,
    changeSummary: string,
    now: number,
    maximumRevisions: number,
  ): Promise<void> {
    await this.database.transaction(async () => {
      const nextRevision =
        (await this.requireRevision(profileId, expectedRevision)) + 1;
      const serialized = JSON.stringify(document);
      try {
        await this.database.run(
          "UPDATE settings_profiles\n           SET name = $1, description = $2, revision = $3, document_json = $4, updated_at = $5\n           WHERE profile_id = $6",
          name,
          description,
          nextRevision,
          serialized,
          now,
          profileId,
        );
      } catch (error) {
        mapNameConflict(error);
      }
      await this.insertVersion(
        profileId,
        nextRevision,
        name,
        description,
        serialized,
        changeSummary,
        now,
      );
      await this.trimVersions(profileId, maximumRevisions);
      await this.database.audit(
        now,
        "settings_profile.updated",
        profileId,
        "success",
      );
    });
  }

  async deleteProfile(profileId: string, now: number): Promise<void> {
    await this.database.transaction(async () => {
      if (
        (await this.database.run(
          "DELETE FROM settings_profiles WHERE profile_id = $1",
          profileId,
        )) !== 1
      ) {
        throw new SettingsStoreError("not-found");
      }
      await this.database.audit(
        now,
        "settings_profile.deleted",
        profileId,
        "success",
      );
    });
  }

  async listVersions(profileId: string): Promise<SettingsProfileVersion[]> {
    if (
      !(await this.database.get(
        "SELECT profile_id FROM settings_profiles WHERE profile_id = $1",
        profileId,
      ))
    ) {
      throw new SettingsStoreError("not-found");
    }
    return (
      await this.database.all(
        "SELECT revision, name, description, change_summary, created_at\n         FROM settings_profile_versions WHERE profile_id = $1 ORDER BY revision DESC",
        profileId,
      )
    ).map((row) => ({
      revision: requiredNumber(row, "revision"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      changeSummary: requiredString(row, "change_summary"),
      createdAt: requiredNumber(row, "created_at"),
    }));
  }

  async restoreVersion(
    profileId: string,
    revision: number,
    expectedRevision: number,
    now: number,
    maximumRevisions: number,
  ): Promise<void> {
    await this.database.transaction(async () => {
      const currentRevision = await this.requireRevision(
        profileId,
        expectedRevision,
      );
      const target = await this.database.get(
        "SELECT name, description, document_json FROM settings_profile_versions\n         WHERE profile_id = $1 AND revision = $2",
        profileId,
        revision,
      );
      if (!target) throw new SettingsStoreError("not-found");
      const nextRevision = currentRevision + 1;
      const name = requiredString(target, "name");
      const description = requiredString(target, "description");
      const document = requiredString(target, "document_json");
      await this.database.run(
        "UPDATE settings_profiles\n         SET name = $1, description = $2, revision = $3, document_json = $4, updated_at = $5\n         WHERE profile_id = $6",
        name,
        description,
        nextRevision,
        document,
        now,
        profileId,
      );
      await this.insertVersion(
        profileId,
        nextRevision,
        name,
        description,
        document,
        `Restored revision ${revision}`,
        now,
      );
      await this.trimVersions(profileId, maximumRevisions);
      await this.database.audit(
        now,
        "settings_profile.restored",
        profileId,
        "success",
      );
    });
  }

  async setSecret(
    cipher: SettingsCipher,
    profileId: string,
    secretId: string,
    value: string,
    expectedRevision: number,
    now: number,
    maximumRevisions: number,
  ): Promise<void> {
    await this.database.transaction(async () => {
      const profile = await this.getVersionSource(profileId, expectedRevision);
      const nextRevision = expectedRevision + 1;
      const encrypted = cipher.encrypt(
        Buffer.from(value),
        secretAad(profileId, secretId),
      );
      await this.database.run(
        "INSERT INTO settings_secrets (profile_id, secret_id, ciphertext, last_four, updated_at)\n         VALUES ($1, $2, $3, $4, $5)\n         ON CONFLICT (profile_id, secret_id) DO UPDATE SET\n           ciphertext = excluded.ciphertext,\n           last_four = excluded.last_four,\n           updated_at = excluded.updated_at",
        profileId,
        secretId,
        encrypted,
        [...value].slice(-4).join(""),
        now,
      );
      await this.advanceRevision(
        profileId,
        nextRevision,
        profile,
        `Updated ${secretId} secret`,
        now,
        maximumRevisions,
      );
      await this.database.audit(
        now,
        "settings_secret.updated",
        `${profileId}:${secretId}`,
        "success",
      );
    });
  }

  async deleteSecret(
    profileId: string,
    secretId: string,
    expectedRevision: number,
    now: number,
    maximumRevisions: number,
  ): Promise<void> {
    await this.database.transaction(async () => {
      const profile = await this.getVersionSource(profileId, expectedRevision);
      if (
        (await this.database.run(
          "DELETE FROM settings_secrets WHERE profile_id = $1 AND secret_id = $2",
          profileId,
          secretId,
        )) !== 1
      ) {
        throw new SettingsStoreError("not-found");
      }
      await this.advanceRevision(
        profileId,
        expectedRevision + 1,
        profile,
        `Removed ${secretId} secret`,
        now,
        maximumRevisions,
      );
      await this.database.audit(
        now,
        "settings_secret.deleted",
        `${profileId}:${secretId}`,
        "success",
      );
    });
  }

  async listAssignments(): Promise<SettingsAssignment[]> {
    return (
      await this.database.all(
        "SELECT i.instance_id, i.display_name, i.revoked_at,\n                a.profile_id, p.name AS profile_name, p.revision AS profile_revision,\n                a.assigned_at, a.last_applied_revision, a.last_applied_at,\n                a.last_sync_revision, a.last_sync_attempt_at, a.last_sync_error\n         FROM instances i\n         LEFT JOIN settings_assignments a ON a.instance_id = i.instance_id\n         LEFT JOIN settings_profiles p ON p.profile_id = a.profile_id\n         ORDER BY lower(i.display_name), i.enrolled_at",
      )
    ).map((row) => {
      const profileRevision = optionalNumber(row, "profile_revision");
      const lastAppliedRevision = optionalNumber(row, "last_applied_revision");
      const lastSyncRevision = optionalNumber(row, "last_sync_revision");
      const lastSyncError = optionalString(row, "last_sync_error");
      const syncStatus = assignmentSyncStatus(
        profileRevision,
        lastAppliedRevision,
        lastSyncRevision,
        lastSyncError,
      );
      return {
        instanceId: requiredString(row, "instance_id"),
        displayName: requiredString(row, "display_name"),
        instanceStatus: row.revoked_at === null ? "offline" : "revoked",
        profileId: optionalString(row, "profile_id"),
        profileName: optionalString(row, "profile_name"),
        profileRevision,
        assignedAt: optionalNumber(row, "assigned_at"),
        lastAppliedRevision,
        lastAppliedAt: optionalNumber(row, "last_applied_at"),
        syncStatus,
        lastSyncRevision,
        lastSyncAttemptAt: optionalNumber(row, "last_sync_attempt_at"),
        syncError: syncStatus === "failed" ? lastSyncError : null,
      };
    });
  }

  async setAssignment(
    instanceId: string,
    profileId: string | null,
    now: number,
  ): Promise<void> {
    await this.database.transaction(async () => {
      if (
        !(await this.database.get(
          "SELECT instance_id FROM instances WHERE instance_id = $1 AND revoked_at IS NULL",
          instanceId,
        ))
      ) {
        throw new SettingsStoreError("not-found");
      }
      if (profileId === null) {
        await this.database.run(
          "DELETE FROM settings_assignments WHERE instance_id = $1",
          instanceId,
        );
      } else {
        if (
          !(await this.database.get(
            "SELECT profile_id FROM settings_profiles WHERE profile_id = $1",
            profileId,
          ))
        ) {
          throw new SettingsStoreError("not-found");
        }
        await this.database.run(
          "INSERT INTO settings_assignments\n           (instance_id, profile_id, assigned_at, last_applied_revision, last_applied_at,\n            last_sync_revision, last_sync_attempt_at, last_sync_error)\n           VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL)\n           ON CONFLICT (instance_id) DO UPDATE SET\n             profile_id = excluded.profile_id,\n             assigned_at = excluded.assigned_at,\n             last_applied_revision = NULL,\n             last_applied_at = NULL,\n             last_sync_revision = NULL,\n             last_sync_attempt_at = NULL,\n             last_sync_error = NULL",
          instanceId,
          profileId,
          now,
        );
      }
      await this.database.audit(
        now,
        "settings_assignment.updated",
        instanceId,
        "success",
      );
    });
  }

  async getDelivery(
    cipher: SettingsCipher,
    instanceId: string,
  ): Promise<SettingsDelivery | null> {
    return await this.database.transaction(async () => {
      const row = await this.database.get(
        "SELECT p.profile_id, p.name, p.revision, p.document_json\n       FROM settings_assignments a\n       JOIN settings_profiles p ON p.profile_id = a.profile_id\n       WHERE a.instance_id = $1 AND EXISTS (SELECT 1 FROM cloud_installation WHERE id=1 AND coalesce((remote_config#>>'{settingsManager,enabled}')::boolean,true))",
        instanceId,
      );
      if (!row) return null;
      const profileId = requiredString(row, "profile_id");
      const secrets: Record<string, string> = {};
      for (const secret of await this.database.all(
        "SELECT secret_id, ciphertext FROM settings_secrets WHERE profile_id = $1 ORDER BY secret_id",
        profileId,
      )) {
        const secretId = requiredString(secret, "secret_id");
        const ciphertext = secret.ciphertext;
        if (!(ciphertext instanceof Uint8Array))
          throw new Error("Encrypted setting is invalid.");
        secrets[secretId] = cipher
          .decrypt(Buffer.from(ciphertext), secretAad(profileId, secretId))
          .toString("utf8");
      }
      return {
        profileId,
        name: requiredString(row, "name"),
        revision: requiredNumber(row, "revision"),
        document: parseDocument(requiredString(row, "document_json")),
        secrets,
      };
    });
  }

  async getDeliveryIdentity(
    instanceId: string,
  ): Promise<SettingsDeliveryIdentity | null> {
    const row = await this.database.get(
      "SELECT p.profile_id, p.revision\n       FROM settings_assignments a\n       JOIN settings_profiles p ON p.profile_id = a.profile_id\n       WHERE a.instance_id = $1 AND EXISTS (SELECT 1 FROM cloud_installation WHERE id=1 AND coalesce((remote_config#>>'{settingsManager,enabled}')::boolean,true))",
      instanceId,
    );
    return row
      ? {
          profileId: requiredString(row, "profile_id"),
          revision: requiredNumber(row, "revision"),
        }
      : null;
  }

  async recordApplied(
    instanceId: string,
    profileId: string | null,
    revision: number | null,
    now: number,
  ): Promise<boolean> {
    if (profileId === null || revision === null) {
      return Boolean(
        await this.database.get(
          "SELECT i.instance_id\n           FROM instances i\n           LEFT JOIN settings_assignments a ON a.instance_id = i.instance_id\n           WHERE i.instance_id = $1 AND i.revoked_at IS NULL\n             AND a.instance_id IS NULL",
          instanceId,
        ),
      );
    }
    return (
      (await this.database.run(
        "UPDATE settings_assignments\n         SET last_applied_revision = $1,\n             last_applied_at = $2,\n             last_sync_revision = $3,\n             last_sync_attempt_at = $4,\n             last_sync_error = NULL\n         WHERE instance_id = $5 AND profile_id = $6\n           AND EXISTS (\n             SELECT 1 FROM settings_profiles\n             WHERE profile_id = $7 AND revision = $8\n           )\n           AND EXISTS (\n             SELECT 1 FROM instances\n             WHERE instance_id = $9 AND revoked_at IS NULL\n           )",
        revision,
        now,
        revision,
        now,
        instanceId,
        profileId,
        profileId,
        revision,
        instanceId,
      )) === 1
    );
  }

  async recordFailure(
    instanceId: string,
    profileId: string | null,
    revision: number | null,
    error: string,
    now: number,
  ): Promise<boolean> {
    if (profileId === null || revision === null) {
      return Boolean(
        await this.database.get(
          "SELECT i.instance_id\n           FROM instances i\n           LEFT JOIN settings_assignments a ON a.instance_id = i.instance_id\n           WHERE i.instance_id = $1 AND i.revoked_at IS NULL\n             AND a.instance_id IS NULL",
          instanceId,
        ),
      );
    }
    return (
      (await this.database.run(
        "UPDATE settings_assignments\n         SET last_sync_revision = $1,\n             last_sync_attempt_at = $2,\n             last_sync_error = $3\n         WHERE instance_id = $4 AND profile_id = $5\n           AND EXISTS (\n             SELECT 1 FROM settings_profiles\n             WHERE profile_id = $6 AND revision = $7\n           )\n           AND EXISTS (\n             SELECT 1 FROM instances\n             WHERE instance_id = $8 AND revoked_at IS NULL\n           )",
        revision,
        now,
        error,
        instanceId,
        profileId,
        profileId,
        revision,
        instanceId,
      )) === 1
    );
  }

  private async requireRevision(
    profileId: string,
    expectedRevision: number,
  ): Promise<number> {
    const row = await this.database.get(
      "SELECT revision FROM settings_profiles WHERE profile_id = $1",
      profileId,
    );
    if (!row) throw new SettingsStoreError("not-found");
    const revision = requiredNumber(row, "revision");
    if (revision !== expectedRevision)
      throw new SettingsStoreError("revision-conflict");
    return revision;
  }

  private async getVersionSource(
    profileId: string,
    expectedRevision: number,
  ): Promise<DatabaseRow> {
    const row = await this.database.get(
      "SELECT name, description, revision, document_json FROM settings_profiles WHERE profile_id = $1",
      profileId,
    );
    if (!row) throw new SettingsStoreError("not-found");
    if (requiredNumber(row, "revision") !== expectedRevision) {
      throw new SettingsStoreError("revision-conflict");
    }
    return row;
  }

  private async advanceRevision(
    profileId: string,
    revision: number,
    source: DatabaseRow,
    summary: string,
    now: number,
    maximumRevisions: number,
  ): Promise<void> {
    const name = requiredString(source, "name");
    const description = requiredString(source, "description");
    const document = requiredString(source, "document_json");
    await this.database.run(
      "UPDATE settings_profiles SET revision = $1, updated_at = $2 WHERE profile_id = $3",
      revision,
      now,
      profileId,
    );
    await this.insertVersion(
      profileId,
      revision,
      name,
      description,
      document,
      summary,
      now,
    );
    await this.trimVersions(profileId, maximumRevisions);
  }

  private async insertVersion(
    profileId: string,
    revision: number,
    name: string,
    description: string,
    document: string,
    summary: string,
    now: number,
  ): Promise<void> {
    await this.database.run(
      "INSERT INTO settings_profile_versions\n       (profile_id, revision, name, description, document_json, change_summary, created_at)\n       VALUES ($1, $2, $3, $4, $5, $6, $7)",
      profileId,
      revision,
      name,
      description,
      document,
      summary,
      now,
    );
  }

  private async trimVersions(
    profileId: string,
    maximumRevisions: number,
  ): Promise<void> {
    await this.database.run(
      "DELETE FROM settings_profile_versions\n       WHERE profile_id = $1 AND revision NOT IN (\n         SELECT revision FROM settings_profile_versions\n         WHERE profile_id = $2 ORDER BY revision DESC LIMIT $3\n       )",
      profileId,
      profileId,
      maximumRevisions,
    );
  }
}

function parseDocument(serialized: string): ManagedSettingsDocument {
  return JSON.parse(serialized) as ManagedSettingsDocument;
}

function assignmentSyncStatus(
  profileRevision: number | null,
  lastAppliedRevision: number | null,
  lastSyncRevision: number | null,
  lastSyncError: string | null,
): SettingsAssignment["syncStatus"] {
  if (profileRevision === null) return "unassigned";
  if (lastSyncRevision === profileRevision && lastSyncError) return "failed";
  if (lastAppliedRevision === profileRevision) return "applied";
  return "pending";
}

function secretAad(profileId: string, secretId: string): Buffer {
  return Buffer.from(`${profileId}\0${secretId}`);
}

function optionalString(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error(`Database field ${key} is invalid.`);
  return value;
}

function mapNameConflict(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "23505") {
    throw new SettingsStoreError("name-conflict");
  }
  throw error;
}
