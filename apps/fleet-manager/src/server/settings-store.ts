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

  listProfiles(): SettingsProfileSummary[] {
    return this.database
      .all(
        `SELECT p.profile_id, p.name, p.description, p.revision, p.document_json,
                p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM settings_secrets s WHERE s.profile_id = p.profile_id) AS secret_count,
                (SELECT COUNT(*) FROM settings_assignments a WHERE a.profile_id = p.profile_id) AS assignment_count
         FROM settings_profiles p ORDER BY p.name COLLATE NOCASE, p.created_at`,
      )
      .map((row) => {
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

  getProfile(profileId: string): SettingsProfile {
    const row = this.database.get(
      `SELECT profile_id, name, description, revision, document_json, created_at, updated_at
       FROM settings_profiles WHERE profile_id = ?`,
      profileId,
    );
    if (!row) throw new SettingsStoreError("not-found");
    const secrets = this.database
      .all(
        `SELECT secret_id, last_four, updated_at FROM settings_secrets
         WHERE profile_id = ? ORDER BY secret_id`,
        profileId,
      )
      .map((secret) => ({
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
  }

  createProfile(
    name: string,
    description: string,
    document: ManagedSettingsDocument,
    now: number,
    maximumProfiles: number,
  ): string {
    return this.database.transaction(() => {
      const count = requiredNumber(
        this.database.get("SELECT COUNT(*) AS count FROM settings_profiles"),
        "count",
      );
      if (count >= maximumProfiles)
        throw new SettingsStoreError("profile-limit");
      const profileId = createId("profile");
      const serialized = JSON.stringify(document);
      try {
        this.database.run(
          `INSERT INTO settings_profiles
           (profile_id, name, description, revision, document_json, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
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
      this.insertVersion(
        profileId,
        1,
        name,
        description,
        serialized,
        "Created profile",
        now,
      );
      this.database.audit(
        now,
        "settings_profile.created",
        profileId,
        "success",
      );
      return profileId;
    });
  }

  updateProfile(
    profileId: string,
    expectedRevision: number,
    name: string,
    description: string,
    document: ManagedSettingsDocument,
    changeSummary: string,
    now: number,
    maximumRevisions: number,
  ): void {
    this.database.transaction(() => {
      const nextRevision =
        this.requireRevision(profileId, expectedRevision) + 1;
      const serialized = JSON.stringify(document);
      try {
        this.database.run(
          `UPDATE settings_profiles
           SET name = ?, description = ?, revision = ?, document_json = ?, updated_at = ?
           WHERE profile_id = ?`,
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
      this.insertVersion(
        profileId,
        nextRevision,
        name,
        description,
        serialized,
        changeSummary,
        now,
      );
      this.trimVersions(profileId, maximumRevisions);
      this.database.audit(
        now,
        "settings_profile.updated",
        profileId,
        "success",
      );
    });
  }

  deleteProfile(profileId: string, now: number): void {
    this.database.transaction(() => {
      if (
        this.database.run(
          "DELETE FROM settings_profiles WHERE profile_id = ?",
          profileId,
        ) !== 1
      ) {
        throw new SettingsStoreError("not-found");
      }
      this.database.audit(
        now,
        "settings_profile.deleted",
        profileId,
        "success",
      );
    });
  }

  listVersions(profileId: string): SettingsProfileVersion[] {
    if (
      !this.database.get(
        "SELECT profile_id FROM settings_profiles WHERE profile_id = ?",
        profileId,
      )
    ) {
      throw new SettingsStoreError("not-found");
    }
    return this.database
      .all(
        `SELECT revision, name, description, change_summary, created_at
         FROM settings_profile_versions WHERE profile_id = ? ORDER BY revision DESC`,
        profileId,
      )
      .map((row) => ({
        revision: requiredNumber(row, "revision"),
        name: requiredString(row, "name"),
        description: requiredString(row, "description"),
        changeSummary: requiredString(row, "change_summary"),
        createdAt: requiredNumber(row, "created_at"),
      }));
  }

  restoreVersion(
    profileId: string,
    revision: number,
    expectedRevision: number,
    now: number,
    maximumRevisions: number,
  ): void {
    this.database.transaction(() => {
      const currentRevision = this.requireRevision(profileId, expectedRevision);
      const target = this.database.get(
        `SELECT name, description, document_json FROM settings_profile_versions
         WHERE profile_id = ? AND revision = ?`,
        profileId,
        revision,
      );
      if (!target) throw new SettingsStoreError("not-found");
      const nextRevision = currentRevision + 1;
      const name = requiredString(target, "name");
      const description = requiredString(target, "description");
      const document = requiredString(target, "document_json");
      this.database.run(
        `UPDATE settings_profiles
         SET name = ?, description = ?, revision = ?, document_json = ?, updated_at = ?
         WHERE profile_id = ?`,
        name,
        description,
        nextRevision,
        document,
        now,
        profileId,
      );
      this.insertVersion(
        profileId,
        nextRevision,
        name,
        description,
        document,
        `Restored revision ${revision}`,
        now,
      );
      this.trimVersions(profileId, maximumRevisions);
      this.database.audit(
        now,
        "settings_profile.restored",
        profileId,
        "success",
      );
    });
  }

  setSecret(
    cipher: SettingsCipher,
    profileId: string,
    secretId: string,
    value: string,
    expectedRevision: number,
    now: number,
    maximumRevisions: number,
  ): void {
    this.database.transaction(() => {
      const profile = this.getVersionSource(profileId, expectedRevision);
      const nextRevision = expectedRevision + 1;
      const encrypted = cipher.encrypt(
        Buffer.from(value),
        secretAad(profileId, secretId),
      );
      this.database.run(
        `INSERT INTO settings_secrets (profile_id, secret_id, ciphertext, last_four, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, secret_id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           last_four = excluded.last_four,
           updated_at = excluded.updated_at`,
        profileId,
        secretId,
        encrypted,
        [...value].slice(-4).join(""),
        now,
      );
      this.advanceRevision(
        profileId,
        nextRevision,
        profile,
        `Updated ${secretId} secret`,
        now,
        maximumRevisions,
      );
      this.database.audit(
        now,
        "settings_secret.updated",
        `${profileId}:${secretId}`,
        "success",
      );
    });
  }

  deleteSecret(
    profileId: string,
    secretId: string,
    expectedRevision: number,
    now: number,
    maximumRevisions: number,
  ): void {
    this.database.transaction(() => {
      const profile = this.getVersionSource(profileId, expectedRevision);
      if (
        this.database.run(
          "DELETE FROM settings_secrets WHERE profile_id = ? AND secret_id = ?",
          profileId,
          secretId,
        ) !== 1
      ) {
        throw new SettingsStoreError("not-found");
      }
      this.advanceRevision(
        profileId,
        expectedRevision + 1,
        profile,
        `Removed ${secretId} secret`,
        now,
        maximumRevisions,
      );
      this.database.audit(
        now,
        "settings_secret.deleted",
        `${profileId}:${secretId}`,
        "success",
      );
    });
  }

  listAssignments(): SettingsAssignment[] {
    return this.database
      .all(
        `SELECT i.instance_id, i.display_name, i.revoked_at,
                a.profile_id, p.name AS profile_name, p.revision AS profile_revision,
                a.assigned_at, a.last_applied_revision, a.last_applied_at,
                a.last_sync_revision, a.last_sync_attempt_at, a.last_sync_error
         FROM instances i
         LEFT JOIN settings_assignments a ON a.instance_id = i.instance_id
         LEFT JOIN settings_profiles p ON p.profile_id = a.profile_id
         ORDER BY i.display_name COLLATE NOCASE, i.enrolled_at`,
      )
      .map((row) => {
        const profileRevision = optionalNumber(row, "profile_revision");
        const lastAppliedRevision = optionalNumber(
          row,
          "last_applied_revision",
        );
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

  setAssignment(
    instanceId: string,
    profileId: string | null,
    now: number,
  ): void {
    this.database.transaction(() => {
      if (
        !this.database.get(
          "SELECT instance_id FROM instances WHERE instance_id = ? AND revoked_at IS NULL",
          instanceId,
        )
      ) {
        throw new SettingsStoreError("not-found");
      }
      if (profileId === null) {
        this.database.run(
          "DELETE FROM settings_assignments WHERE instance_id = ?",
          instanceId,
        );
      } else {
        if (
          !this.database.get(
            "SELECT profile_id FROM settings_profiles WHERE profile_id = ?",
            profileId,
          )
        ) {
          throw new SettingsStoreError("not-found");
        }
        this.database.run(
          `INSERT INTO settings_assignments
           (instance_id, profile_id, assigned_at, last_applied_revision, last_applied_at,
            last_sync_revision, last_sync_attempt_at, last_sync_error)
           VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)
           ON CONFLICT (instance_id) DO UPDATE SET
             profile_id = excluded.profile_id,
             assigned_at = excluded.assigned_at,
             last_applied_revision = NULL,
             last_applied_at = NULL,
             last_sync_revision = NULL,
             last_sync_attempt_at = NULL,
             last_sync_error = NULL`,
          instanceId,
          profileId,
          now,
        );
      }
      this.database.audit(
        now,
        "settings_assignment.updated",
        instanceId,
        "success",
      );
    });
  }

  getDelivery(
    cipher: SettingsCipher,
    instanceId: string,
  ): SettingsDelivery | null {
    const row = this.database.get(
      `SELECT p.profile_id, p.name, p.revision, p.document_json
       FROM settings_assignments a
       JOIN settings_profiles p ON p.profile_id = a.profile_id
       WHERE a.instance_id = ?`,
      instanceId,
    );
    if (!row) return null;
    const profileId = requiredString(row, "profile_id");
    const secrets: Record<string, string> = {};
    for (const secret of this.database.all(
      "SELECT secret_id, ciphertext FROM settings_secrets WHERE profile_id = ? ORDER BY secret_id",
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
  }

  getDeliveryIdentity(instanceId: string): SettingsDeliveryIdentity | null {
    const row = this.database.get(
      `SELECT p.profile_id, p.revision
       FROM settings_assignments a
       JOIN settings_profiles p ON p.profile_id = a.profile_id
       WHERE a.instance_id = ?`,
      instanceId,
    );
    return row
      ? {
          profileId: requiredString(row, "profile_id"),
          revision: requiredNumber(row, "revision"),
        }
      : null;
  }

  recordApplied(
    instanceId: string,
    profileId: string | null,
    revision: number | null,
    now: number,
  ): boolean {
    if (profileId === null || revision === null) {
      return Boolean(
        this.database.get(
          `SELECT i.instance_id
           FROM instances i
           LEFT JOIN settings_assignments a ON a.instance_id = i.instance_id
           WHERE i.instance_id = ? AND i.revoked_at IS NULL
             AND a.instance_id IS NULL`,
          instanceId,
        ),
      );
    }
    return (
      this.database.run(
        `UPDATE settings_assignments
         SET last_applied_revision = ?,
             last_applied_at = ?,
             last_sync_revision = ?,
             last_sync_attempt_at = ?,
             last_sync_error = NULL
         WHERE instance_id = ? AND profile_id = ?
           AND EXISTS (
             SELECT 1 FROM settings_profiles
             WHERE profile_id = ? AND revision = ?
           )
           AND EXISTS (
             SELECT 1 FROM instances
             WHERE instance_id = ? AND revoked_at IS NULL
           )`,
        revision,
        now,
        revision,
        now,
        instanceId,
        profileId,
        profileId,
        revision,
        instanceId,
      ) === 1
    );
  }

  recordFailure(
    instanceId: string,
    profileId: string | null,
    revision: number | null,
    error: string,
    now: number,
  ): boolean {
    if (profileId === null || revision === null) {
      return Boolean(
        this.database.get(
          `SELECT i.instance_id
           FROM instances i
           LEFT JOIN settings_assignments a ON a.instance_id = i.instance_id
           WHERE i.instance_id = ? AND i.revoked_at IS NULL
             AND a.instance_id IS NULL`,
          instanceId,
        ),
      );
    }
    return (
      this.database.run(
        `UPDATE settings_assignments
         SET last_sync_revision = ?,
             last_sync_attempt_at = ?,
             last_sync_error = ?
         WHERE instance_id = ? AND profile_id = ?
           AND EXISTS (
             SELECT 1 FROM settings_profiles
             WHERE profile_id = ? AND revision = ?
           )
           AND EXISTS (
             SELECT 1 FROM instances
             WHERE instance_id = ? AND revoked_at IS NULL
           )`,
        revision,
        now,
        error,
        instanceId,
        profileId,
        profileId,
        revision,
        instanceId,
      ) === 1
    );
  }

  private requireRevision(profileId: string, expectedRevision: number): number {
    const row = this.database.get(
      "SELECT revision FROM settings_profiles WHERE profile_id = ?",
      profileId,
    );
    if (!row) throw new SettingsStoreError("not-found");
    const revision = requiredNumber(row, "revision");
    if (revision !== expectedRevision)
      throw new SettingsStoreError("revision-conflict");
    return revision;
  }

  private getVersionSource(
    profileId: string,
    expectedRevision: number,
  ): DatabaseRow {
    const row = this.database.get(
      "SELECT name, description, revision, document_json FROM settings_profiles WHERE profile_id = ?",
      profileId,
    );
    if (!row) throw new SettingsStoreError("not-found");
    if (requiredNumber(row, "revision") !== expectedRevision) {
      throw new SettingsStoreError("revision-conflict");
    }
    return row;
  }

  private advanceRevision(
    profileId: string,
    revision: number,
    source: DatabaseRow,
    summary: string,
    now: number,
    maximumRevisions: number,
  ): void {
    const name = requiredString(source, "name");
    const description = requiredString(source, "description");
    const document = requiredString(source, "document_json");
    this.database.run(
      "UPDATE settings_profiles SET revision = ?, updated_at = ? WHERE profile_id = ?",
      revision,
      now,
      profileId,
    );
    this.insertVersion(
      profileId,
      revision,
      name,
      description,
      document,
      summary,
      now,
    );
    this.trimVersions(profileId, maximumRevisions);
  }

  private insertVersion(
    profileId: string,
    revision: number,
    name: string,
    description: string,
    document: string,
    summary: string,
    now: number,
  ): void {
    this.database.run(
      `INSERT INTO settings_profile_versions
       (profile_id, revision, name, description, document_json, change_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      profileId,
      revision,
      name,
      description,
      document,
      summary,
      now,
    );
  }

  private trimVersions(profileId: string, maximumRevisions: number): void {
    this.database.run(
      `DELETE FROM settings_profile_versions
       WHERE profile_id = ? AND revision NOT IN (
         SELECT revision FROM settings_profile_versions
         WHERE profile_id = ? ORDER BY revision DESC LIMIT ?
       )`,
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
  if (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed")
  ) {
    throw new SettingsStoreError("name-conflict");
  }
  throw error;
}
