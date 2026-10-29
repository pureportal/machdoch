import {
  maximumManagedSettingsLayers,
  maximumManagedSettingsSecrets,
} from "@machdoch/fleet-protocol";
import {
  composeManagedSettingsLayers,
  managedSecretPolicyKey,
} from "@machdoch/fleet-protocol/managed-settings";
import { createId } from "./crypto";
import {
  type DatabaseRow,
  type FleetDatabase,
  optionalNumber,
  requiredNumber,
  requiredString,
} from "./database";
import type { SettingsCipher } from "./settings-crypto";
import { shortenText, type ManagedSettingsDocument } from "./settings";

export type SettingsStoreErrorCode =
  | "not-found"
  | "revision-conflict"
  | "profile-limit"
  | "name-conflict"
  | "layer-limit"
  | "secret-limit";

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

export type SettingsLayerSyncStatus = "pending" | "applied" | "failed";

export interface SettingsAssignmentLayer {
  profileId: string;
  profileName: string;
  profileRevision: number;
  position: number;
  assignedAt: number;
  lastAppliedRevision: number | null;
  lastAppliedAt: number | null;
  syncStatus: SettingsLayerSyncStatus;
  lastSyncRevision: number | null;
  lastSyncAttemptAt: number | null;
  syncError: string | null;
}

/** The flat profile fields describe the first (highest-priority) layer. */
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
  syncStatus: "unassigned" | SettingsLayerSyncStatus;
  lastSyncRevision: number | null;
  lastSyncAttemptAt: number | null;
  syncError: string | null;
  layers: SettingsAssignmentLayer[];
  warnings: string[];
  snapshot: { capturedAt: number | null; refreshRequestedAt: number | null };
}

export interface SettingsDeliveryLayer {
  profileId: string;
  name: string;
  revision: number;
  document: ManagedSettingsDocument;
  secrets: Record<string, string>;
}

/** Effective settings of all layers plus the layers they came from. */
export interface SettingsDelivery extends SettingsDeliveryLayer {
  layers: SettingsDeliveryLayer[];
}

export interface SettingsLayerIdentity {
  profileId: string;
  revision: number;
}

export interface SettingsDeliveryIdentity extends SettingsLayerIdentity {
  layers: SettingsLayerIdentity[];
}

const deliveryEnabledClause =
  "EXISTS (SELECT 1 FROM cloud_installation WHERE id=1 AND coalesce((remote_config#>>'{settingsManager,enabled}')::boolean,true))";

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
        "SELECT p.profile_id, p.name, p.description, p.revision, p.document_json,\n                p.created_at, p.updated_at,\n                (SELECT COUNT(*)::integer FROM settings_secrets s WHERE s.profile_id = p.profile_id) AS secret_count,\n                (SELECT COUNT(*)::integer FROM settings_profile_assignments a WHERE a.profile_id = p.profile_id) AS assignment_count\n         FROM settings_profiles p ORDER BY lower(p.name), p.created_at",
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
      // Devices that stack this profile get a new composition: close the gap
      // it leaves and require the remaining layers to be applied again.
      await this.database.run(
        "UPDATE settings_profile_assignments a\n         SET position = a.position - CASE WHEN a.position > d.position THEN 1 ELSE 0 END,\n             last_applied_revision = NULL,\n             last_applied_at = NULL,\n             last_sync_revision = NULL,\n             last_sync_attempt_at = NULL,\n             last_sync_error = NULL\n         FROM settings_profile_assignments d\n         WHERE d.profile_id = $1 AND a.instance_id = d.instance_id AND a.profile_id <> d.profile_id",
        profileId,
      );
      await this.database.run(
        "DELETE FROM settings_sync_warnings w\n         WHERE EXISTS (\n           SELECT 1 FROM settings_profile_assignments a\n           WHERE a.instance_id = w.instance_id AND a.profile_id = $1\n         )",
        profileId,
      );
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

  async getVersionDocument(
    profileId: string,
    revision: number,
  ): Promise<ManagedSettingsDocument> {
    const row = await this.database.get(
      "SELECT document_json FROM settings_profile_versions WHERE profile_id = $1 AND revision = $2",
      profileId,
      revision,
    );
    if (!row) throw new SettingsStoreError("not-found");
    return parseDocument(requiredString(row, "document_json"));
  }

  /** Distinct ordered layers of active devices that stack `profileId` with others. */
  async listProfileStacks(profileId: string): Promise<string[][]> {
    return (
      await this.database.all(
        "SELECT DISTINCT array_agg(a.profile_id ORDER BY a.position) AS profile_ids\n         FROM settings_profile_assignments a\n         JOIN instances i ON i.instance_id = a.instance_id AND i.revoked_at IS NULL\n         WHERE a.instance_id IN (\n           SELECT instance_id FROM settings_profile_assignments WHERE profile_id = $1\n         )\n         GROUP BY a.instance_id\n         HAVING COUNT(*) > 1",
        profileId,
      )
    ).map((row) => {
      const profileIds = row.profile_ids;
      if (
        !Array.isArray(profileIds) ||
        !profileIds.every((value) => typeof value === "string")
      )
        throw new Error("Database field profile_ids is invalid.");
      return profileIds as string[];
    });
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
      const others = requiredNumber(
        await this.database.get(
          "SELECT COUNT(*)::integer AS count FROM settings_secrets WHERE profile_id = $1 AND secret_id <> $2",
          profileId,
          secretId,
        ),
        "count",
      );
      // Devices reject deliveries with more secrets than the protocol allows.
      if (others >= maximumManagedSettingsSecrets)
        throw new SettingsStoreError("secret-limit");
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
        withoutSecretPolicy(requiredString(profile, "document_json"), secretId),
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
    return await this.database.transaction(async () => {
      const instances = await this.database.all(
        "SELECT i.instance_id, i.display_name, i.revoked_at, e.captured_at, r.requested_at,\n                w.warnings_json\n         FROM instances i\n         LEFT JOIN enrollment_settings e ON e.instance_id = i.instance_id\n         LEFT JOIN settings_snapshot_requests r ON r.instance_id = i.instance_id\n         LEFT JOIN settings_sync_warnings w ON w.instance_id = i.instance_id\n         ORDER BY lower(i.display_name), i.enrolled_at",
      );
      const layersByInstance = new Map<string, SettingsAssignmentLayer[]>();
      for (const row of await this.database.all(
        "SELECT a.instance_id, a.profile_id, a.position, a.assigned_at, p.name AS profile_name,\n                p.revision AS profile_revision, a.last_applied_revision, a.last_applied_at,\n                a.last_sync_revision, a.last_sync_attempt_at, a.last_sync_error\n         FROM settings_profile_assignments a\n         JOIN settings_profiles p ON p.profile_id = a.profile_id\n         ORDER BY a.instance_id, a.position",
      )) {
        const instanceId = requiredString(row, "instance_id");
        const profileRevision = requiredNumber(row, "profile_revision");
        const lastAppliedRevision = optionalNumber(
          row,
          "last_applied_revision",
        );
        const lastSyncRevision = optionalNumber(row, "last_sync_revision");
        const lastSyncError = optionalString(row, "last_sync_error");
        const syncStatus = layerSyncStatus(
          profileRevision,
          lastAppliedRevision,
          lastSyncRevision,
          lastSyncError,
        );
        const layers = layersByInstance.get(instanceId) ?? [];
        layers.push({
          profileId: requiredString(row, "profile_id"),
          profileName: requiredString(row, "profile_name"),
          profileRevision,
          position: requiredNumber(row, "position"),
          assignedAt: requiredNumber(row, "assigned_at"),
          lastAppliedRevision,
          lastAppliedAt: optionalNumber(row, "last_applied_at"),
          syncStatus,
          lastSyncRevision,
          lastSyncAttemptAt: optionalNumber(row, "last_sync_attempt_at"),
          syncError: syncStatus === "failed" ? lastSyncError : null,
        });
        layersByInstance.set(instanceId, layers);
      }
      return instances.map((row) => {
        const instanceId = requiredString(row, "instance_id");
        const layers = layersByInstance.get(instanceId) ?? [];
        const first = layers[0];
        // Every layered report and cloud-side failure covers all layers, so
        // a stack whose lower layers were never reported comes from an old
        // client that only applies the first layer.
        const reported =
          first &&
          first.lastSyncAttemptAt !== null &&
          layers.slice(1).every((layer) => layer.lastSyncAttemptAt === null)
            ? [first]
            : layers;
        const failed = reported.find((layer) => layer.syncStatus === "failed");
        return {
          instanceId,
          displayName: requiredString(row, "display_name"),
          instanceStatus: row.revoked_at === null ? "offline" : "revoked",
          profileId: first?.profileId ?? null,
          profileName: first?.profileName ?? null,
          profileRevision: first?.profileRevision ?? null,
          assignedAt: first?.assignedAt ?? null,
          lastAppliedRevision: first?.lastAppliedRevision ?? null,
          lastAppliedAt: first?.lastAppliedAt ?? null,
          syncStatus: !layers.length
            ? "unassigned"
            : failed
              ? "failed"
              : reported.some((layer) => layer.syncStatus === "pending")
                ? "pending"
                : "applied",
          lastSyncRevision: first?.lastSyncRevision ?? null,
          lastSyncAttemptAt: (failed ?? first)?.lastSyncAttemptAt ?? null,
          syncError: failed?.syncError ?? null,
          layers,
          warnings: parseWarnings(optionalString(row, "warnings_json")),
          snapshot: {
            capturedAt: optionalNumber(row, "captured_at"),
            refreshRequestedAt: optionalNumber(row, "requested_at"),
          },
        };
      });
    });
  }

  /** Replaces a device's ordered profile layers (highest priority first). */
  async setAssignments(
    instanceId: string,
    profileIds: string[],
    now: number,
  ): Promise<void> {
    if (profileIds.length > maximumManagedSettingsLayers)
      throw new SettingsStoreError("layer-limit");
    if (new Set(profileIds).size !== profileIds.length)
      throw new SettingsStoreError("layer-limit");
    await this.database.transaction(async () => {
      if (
        !(await this.database.get(
          "SELECT instance_id FROM instances WHERE instance_id = $1 AND revoked_at IS NULL",
          instanceId,
        ))
      ) {
        throw new SettingsStoreError("not-found");
      }
      for (const profileId of profileIds) {
        if (
          !(await this.database.get(
            "SELECT profile_id FROM settings_profiles WHERE profile_id = $1",
            profileId,
          ))
        ) {
          throw new SettingsStoreError("not-found");
        }
      }
      const current = (
        await this.database.all(
          "SELECT profile_id FROM settings_profile_assignments WHERE instance_id = $1 ORDER BY position",
          instanceId,
        )
      ).map((row) => requiredString(row, "profile_id"));
      if (current.join("\n") !== profileIds.join("\n")) {
        // Any change alters the composition, so every layer must be applied again.
        await this.database.run(
          "DELETE FROM settings_profile_assignments WHERE instance_id = $1",
          instanceId,
        );
        for (const [position, profileId] of profileIds.entries()) {
          await this.database.run(
            "INSERT INTO settings_profile_assignments\n             (instance_id, profile_id, position, assigned_at)\n             VALUES ($1, $2, $3, $4)",
            instanceId,
            profileId,
            position,
            now,
          );
        }
        await this.database.run(
          "DELETE FROM settings_sync_warnings WHERE instance_id = $1",
          instanceId,
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

  async setAssignment(
    instanceId: string,
    profileId: string | null,
    now: number,
  ): Promise<void> {
    await this.setAssignments(instanceId, profileId ? [profileId] : [], now);
  }

  async getDelivery(
    cipher: SettingsCipher,
    instanceId: string,
  ): Promise<SettingsDelivery | null> {
    return await this.database.transaction(async () => {
      const rows = await this.database.all(
        `SELECT p.profile_id, p.name, p.revision, p.document_json\n       FROM settings_profile_assignments a\n       JOIN settings_profiles p ON p.profile_id = a.profile_id\n       WHERE a.instance_id = $1 AND ${deliveryEnabledClause}\n       ORDER BY a.position`,
        instanceId,
      );
      if (!rows.length) return null;
      const layers: SettingsDeliveryLayer[] = [];
      for (const row of rows) {
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
        layers.push({
          profileId,
          name: requiredString(row, "name"),
          revision: requiredNumber(row, "revision"),
          document: parseDocument(requiredString(row, "document_json")),
          secrets,
        });
      }
      return composeSettingsDelivery(layers);
    });
  }

  async getDeliveryIdentity(
    instanceId: string,
  ): Promise<SettingsDeliveryIdentity | null> {
    const layers = (
      await this.database.all(
        `SELECT p.profile_id, p.revision\n       FROM settings_profile_assignments a\n       JOIN settings_profiles p ON p.profile_id = a.profile_id\n       WHERE a.instance_id = $1 AND ${deliveryEnabledClause}\n       ORDER BY a.position`,
        instanceId,
      )
    ).map((row) => ({
      profileId: requiredString(row, "profile_id"),
      revision: requiredNumber(row, "revision"),
    }));
    const first = layers[0];
    return first ? { ...first, layers } : null;
  }

  /** Records a legacy single-profile report, which covers the first layer only. */
  async recordApplied(
    instanceId: string,
    profileId: string | null,
    revision: number | null,
    now: number,
    warnings: string[] = [],
  ): Promise<boolean> {
    return await this.database.transaction(async () => {
      if (profileId === null || revision === null) {
        const unassigned = await this.isUnassigned(instanceId);
        if (unassigned) await this.storeWarnings(instanceId, warnings, now);
        return unassigned;
      }
      const layer = { profileId, revision };
      const first = await this.firstLayer(instanceId);
      if (
        first?.profileId !== profileId ||
        !(await this.recordLayerApplied(instanceId, layer, now))
      )
        return false;
      const notice = await this.recordLegacyStack(instanceId, first);
      await this.storeWarnings(
        instanceId,
        notice ? [notice, ...warnings].slice(0, 32) : warnings,
        now,
      );
      return true;
    });
  }

  async recordFailure(
    instanceId: string,
    profileId: string | null,
    revision: number | null,
    error: string,
    now: number,
  ): Promise<boolean> {
    return await this.database.transaction(async () => {
      if (profileId === null || revision === null)
        return await this.isUnassigned(instanceId);
      const layer = { profileId, revision };
      const first = await this.firstLayer(instanceId);
      if (
        first?.profileId !== profileId ||
        !(await this.recordLayerFailure(instanceId, layer, error, now))
      )
        return false;
      const notice = await this.recordLegacyStack(instanceId, first);
      if (notice) await this.storeWarnings(instanceId, [notice], now);
      return true;
    });
  }

  /**
   * Marks the delivered layers failed with a problem the cloud found itself.
   * Rows that already carry the error stay untouched, so polling devices do
   * not cause a write per request.
   */
  async recordDeliveryFailure(
    instanceId: string,
    layers: SettingsLayerIdentity[],
    error: string,
    now: number,
  ): Promise<void> {
    await this.database.transaction(async () => {
      for (const layer of layers)
        await this.database.run(
          "UPDATE settings_profile_assignments\n           SET last_sync_revision = $1,\n               last_sync_attempt_at = $2,\n               last_sync_error = $3\n           WHERE instance_id = $4 AND profile_id = $5\n             AND (last_sync_revision IS DISTINCT FROM $6 OR last_sync_error IS DISTINCT FROM $7)\n             AND EXISTS (\n               SELECT 1 FROM settings_profiles\n               WHERE profile_id = $8 AND revision = $9\n             )\n             AND EXISTS (\n               SELECT 1 FROM instances\n               WHERE instance_id = $10 AND revoked_at IS NULL\n             )",
          layer.revision,
          now,
          error,
          instanceId,
          layer.profileId,
          layer.revision,
          error,
          layer.profileId,
          layer.revision,
          instanceId,
        );
    });
  }

  /** Records a layered report; the layers must match the current assignment. */
  async recordAppliedLayers(
    instanceId: string,
    layers: SettingsLayerIdentity[],
    warnings: string[],
    now: number,
  ): Promise<boolean> {
    return await this.database.transaction(async () => {
      if (!(await this.matchesCurrentLayers(instanceId, layers))) return false;
      for (const layer of layers)
        if (!(await this.recordLayerApplied(instanceId, layer, now)))
          return false;
      await this.storeWarnings(instanceId, warnings, now);
      return true;
    });
  }

  async recordFailedLayers(
    instanceId: string,
    layers: SettingsLayerIdentity[],
    error: string,
    now: number,
  ): Promise<boolean> {
    return await this.database.transaction(async () => {
      if (!(await this.matchesCurrentLayers(instanceId, layers))) return false;
      for (const layer of layers)
        if (!(await this.recordLayerFailure(instanceId, layer, error, now)))
          return false;
      return true;
    });
  }

  private async matchesCurrentLayers(
    instanceId: string,
    layers: SettingsLayerIdentity[],
  ): Promise<boolean> {
    const current = (
      await this.database.all(
        "SELECT a.profile_id, p.revision\n         FROM settings_profile_assignments a\n         JOIN settings_profiles p ON p.profile_id = a.profile_id\n         JOIN instances i ON i.instance_id = a.instance_id AND i.revoked_at IS NULL\n         WHERE a.instance_id = $1",
        instanceId,
      )
    ).map(
      (row) =>
        `${requiredString(row, "profile_id")}:${requiredNumber(row, "revision")}`,
    );
    const reported = layers.map(
      (layer) => `${layer.profileId}:${layer.revision}`,
    );
    return (
      current.length === reported.length &&
      new Set(reported).size === reported.length &&
      reported.every((entry) => current.includes(entry))
    );
  }

  private async firstLayer(
    instanceId: string,
  ): Promise<{ profileId: string; name: string; layerCount: number } | null> {
    const row = await this.database.get(
      "SELECT a.profile_id, p.name, COUNT(*) OVER ()::integer AS layer_count\n       FROM settings_profile_assignments a\n       JOIN settings_profiles p ON p.profile_id = a.profile_id\n       WHERE a.instance_id = $1\n       ORDER BY a.position\n       LIMIT 1",
      instanceId,
    );
    return row
      ? {
          profileId: requiredString(row, "profile_id"),
          name: requiredString(row, "name"),
          layerCount: requiredNumber(row, "layer_count"),
        }
      : null;
  }

  /**
   * Old clients receive and apply the first layer only. Their reports clear
   * the lower layers' sync state, which also lets the aggregate status follow
   * the first layer, and return the notice shown for the device.
   */
  private async recordLegacyStack(
    instanceId: string,
    first: { profileId: string; name: string; layerCount: number },
  ): Promise<string | null> {
    if (first.layerCount < 2) return null;
    await this.database.run(
      "UPDATE settings_profile_assignments\n       SET last_applied_revision = NULL,\n           last_applied_at = NULL,\n           last_sync_revision = NULL,\n           last_sync_attempt_at = NULL,\n           last_sync_error = NULL\n       WHERE instance_id = $1 AND profile_id <> $2",
      instanceId,
      first.profileId,
    );
    return `This device runs an older Machdoch version and only applies the first profile (${first.name}). Update Machdoch to apply all profiles.`;
  }

  private async isUnassigned(instanceId: string): Promise<boolean> {
    return Boolean(
      await this.database.get(
        "SELECT i.instance_id\n         FROM instances i\n         WHERE i.instance_id = $1 AND i.revoked_at IS NULL\n           AND NOT EXISTS (SELECT 1 FROM settings_profile_assignments a WHERE a.instance_id = i.instance_id)",
        instanceId,
      ),
    );
  }

  private async recordLayerApplied(
    instanceId: string,
    layer: SettingsLayerIdentity,
    now: number,
  ): Promise<boolean> {
    return (
      (await this.database.run(
        "UPDATE settings_profile_assignments\n         SET last_applied_revision = $1,\n             last_applied_at = $2,\n             last_sync_revision = $3,\n             last_sync_attempt_at = $4,\n             last_sync_error = NULL\n         WHERE instance_id = $5 AND profile_id = $6\n           AND EXISTS (\n             SELECT 1 FROM settings_profiles\n             WHERE profile_id = $7 AND revision = $8\n           )\n           AND EXISTS (\n             SELECT 1 FROM instances\n             WHERE instance_id = $9 AND revoked_at IS NULL\n           )",
        layer.revision,
        now,
        layer.revision,
        now,
        instanceId,
        layer.profileId,
        layer.profileId,
        layer.revision,
        instanceId,
      )) === 1
    );
  }

  private async recordLayerFailure(
    instanceId: string,
    layer: SettingsLayerIdentity,
    error: string,
    now: number,
  ): Promise<boolean> {
    return (
      (await this.database.run(
        "UPDATE settings_profile_assignments\n         SET last_sync_revision = $1,\n             last_sync_attempt_at = $2,\n             last_sync_error = $3\n         WHERE instance_id = $4 AND profile_id = $5\n           AND EXISTS (\n             SELECT 1 FROM settings_profiles\n             WHERE profile_id = $6 AND revision = $7\n           )\n           AND EXISTS (\n             SELECT 1 FROM instances\n             WHERE instance_id = $8 AND revoked_at IS NULL\n           )",
        layer.revision,
        now,
        error,
        instanceId,
        layer.profileId,
        layer.profileId,
        layer.revision,
        instanceId,
      )) === 1
    );
  }

  private async storeWarnings(
    instanceId: string,
    warnings: string[],
    now: number,
  ): Promise<void> {
    if (!warnings.length) {
      await this.database.run(
        "DELETE FROM settings_sync_warnings WHERE instance_id = $1",
        instanceId,
      );
      return;
    }
    await this.database.run(
      "INSERT INTO settings_sync_warnings (instance_id, warnings_json, reported_at)\n       VALUES ($1, $2, $3)\n       ON CONFLICT (instance_id) DO UPDATE SET\n         warnings_json = excluded.warnings_json,\n         reported_at = excluded.reported_at",
      instanceId,
      JSON.stringify(warnings),
      now,
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
    document = requiredString(source, "document_json"),
  ): Promise<void> {
    const name = requiredString(source, "name");
    const description = requiredString(source, "description");
    await this.database.run(
      "UPDATE settings_profiles SET revision = $1, document_json = $2, updated_at = $3 WHERE profile_id = $4",
      revision,
      document,
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

/** Drops a removed secret's policy key, so adding it again starts as a default. */
function withoutSecretPolicy(serialized: string, secretId: string): string {
  const document = parseDocument(serialized);
  const key = managedSecretPolicyKey(secretId);
  if (!document.policy?.enforced.includes(key)) return serialized;
  return JSON.stringify({
    ...document,
    policy: {
      enforced: document.policy.enforced.filter((entry) => entry !== key),
    },
  });
}

/**
 * Combines ordered layers; the first layer names the delivery. A single layer
 * still gets an explicit policy so clients never see two encodings of it.
 */
function composeSettingsDelivery(
  layers: SettingsDeliveryLayer[],
): SettingsDelivery {
  const first = layers[0];
  if (!first) throw new Error("A settings delivery requires a layer.");
  const composed = composeManagedSettingsLayers(layers);
  return {
    profileId: first.profileId,
    // Delivered profile names are limited to 120 UTF-16 code units.
    name: shortenText(layers.map((layer) => layer.name).join(" + "), 120),
    revision: first.revision,
    document: composed.document as ManagedSettingsDocument,
    secrets: composed.secrets,
    layers,
  };
}

function layerSyncStatus(
  profileRevision: number,
  lastAppliedRevision: number | null,
  lastSyncRevision: number | null,
  lastSyncError: string | null,
): SettingsLayerSyncStatus {
  if (lastSyncRevision === profileRevision && lastSyncError) return "failed";
  if (lastAppliedRevision === profileRevision) return "applied";
  return "pending";
}

function parseWarnings(serialized: string | null): string[] {
  if (!serialized) return [];
  const parsed: unknown = JSON.parse(serialized);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
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
