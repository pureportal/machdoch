import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import type { CloudDatabase, CloudSql } from "./database";
import { cloudCredentialsCipher } from "./credential-storage";
import type { StoredInstallation } from "./installation-storage";
import {
  canonicalRow,
  importTables,
  type ImportRow,
  type LegacySource,
} from "./legacy-source";
import { validateSettingsDocument } from "../settings";
import { finishImportCleanup } from "./legacy-cleanup";

export interface ImportResult {
  organizationId: string;
  userId: string;
  counts: Record<string, number>;
  cleaned: boolean;
}

export async function importLegacySource(
  database: CloudDatabase,
  source: LegacySource,
  installation: StoredInstallation,
): Promise<ImportResult> {
  let committed = false;
  try {
    const result = await database.transaction(async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(1940327612)");
      const previous = (
        await sql.query<{
          source_digest: string;
          organization_id: string;
          user_id: string;
          row_counts: Record<string, number>;
        }>("SELECT * FROM cloud_imports WHERE source_id=$1 FOR UPDATE", [
          source.sourceId,
        ])
      ).rows[0];
      if (previous) {
        if (previous.source_digest !== source.digest)
          throw new Error(
            "The SQLite source changed after import. No source files were removed.",
          );
        return {
          organizationId: previous.organization_id,
          userId: previous.user_id,
          counts: previous.row_counts,
        };
      }
      for (const table of importTables.filter((name) => name !== "metadata")) {
        if (
          (await sql.query(`SELECT 1 FROM remote.${table} LIMIT 1`)).rows.length
        )
          throw new Error(
            "Cloud already contains remote device data. Import into an empty installation to avoid replacing existing data.",
          );
      }
      const ownerName = String(source.owner.username);
      const collision = (
        await sql.query(
          "SELECT id FROM cloud_users WHERE lower(coalesce(login_name,email))=lower($1)",
          [ownerName],
        )
      ).rows[0];
      if (collision)
        throw new Error(
          "An account with the imported owner's login already exists. Resolve the account conflict before importing.",
        );
      const organizationId = installation.organization_id ?? randomUUID();
      const userId = randomUUID();
      if (!installation.organization_id)
        await sql.query(
          "INSERT INTO cloud_organizations (id,name) VALUES ($1,$2)",
          [organizationId, ownerName],
        );
      await sql.query(
        "INSERT INTO cloud_users (id,email,login_name,name,password_hash,created_at) VALUES ($1,$2,$3,$3,$4,to_timestamp($5))",
        [
          userId,
          null,
          ownerName,
          source.owner.password_hash,
          source.owner.created_at,
        ],
      );
      await sql.query(
        "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
        [organizationId, userId],
      );
      const {
        database: _database,
        sessionPolicy: _sessionPolicy,
        settingsManager,
        ...configuration
      } = source.config;
      const remoteConfig = {
        ...configuration,
        settingsManager: {
          enabled: settingsManager.enabled,
          limits: settingsManager.limits,
        },
      };
      await sql.query(
        "UPDATE cloud_installation SET organization_id=$1,origin=$2,remote_config=$3 WHERE id=1",
        [
          organizationId,
          new URL(source.config.externalBaseUrl).origin,
          remoteConfig,
        ],
      );
      await sql.query("DELETE FROM remote.metadata");
      const counts: Record<string, number> = {};
      for (const table of importTables) {
        const rows = migratedRows(source, table, installation.credentials_key);
        for (let offset = 0; offset < rows.length; offset += 200) {
          const batch = rows.slice(offset, offset + 200);
          const columns = Object.keys(batch[0]!);
          if (columns.some((column) => !/^[a-z_]+$/.test(column)))
            throw new Error("The migration source has an unsupported column.");
          await sql.query(
            `INSERT INTO remote.${table} (${columns.join(",")}) VALUES ${batch.map((_, rowIndex) => `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(",")})`).join(",")}`,
            batch.flatMap((row) =>
              columns.map((column) =>
                row[column] instanceof Uint8Array
                  ? Buffer.from(row[column])
                  : row[column],
              ),
            ),
          );
        }
        const stored = (await sql.query(`SELECT * FROM remote.${table}`)).rows;
        if (
          rows.map(canonicalRow).sort().join("\n") !==
          stored.map(canonicalRow).sort().join("\n")
        )
          throw new Error(
            `Imported ${table} data failed verification. The source has been retained.`,
          );
        counts[table] = rows.length;
      }
      // Imported single-profile assignments become the first layer, exactly
      // as the remote schema migrates them on startup.
      await sql.query(
        "INSERT INTO remote.settings_profile_assignments (instance_id,profile_id,position,assigned_at,last_applied_revision,last_applied_at,last_sync_revision,last_sync_attempt_at,last_sync_error) SELECT instance_id,profile_id,0,assigned_at,last_applied_revision,last_applied_at,last_sync_revision,last_sync_attempt_at,last_sync_error FROM remote.settings_assignments ON CONFLICT DO NOTHING",
      );
      await sql.query("DELETE FROM remote.settings_assignments");
      await sql.query(
        "SELECT setval(pg_get_serial_sequence('remote.audit_log','id'),COALESCE((SELECT MAX(id) FROM remote.audit_log),0)+1,false)",
      );
      await sql.query(
        "INSERT INTO cloud_imports (source_id,source_digest,organization_id,user_id,row_counts,source_path,config_path,cleanup_files) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          source.sourceId,
          source.digest,
          organizationId,
          userId,
          counts,
          source.path,
          source.configPath,
          JSON.stringify(source.cleanupFiles),
        ],
      );
      return { organizationId, userId, counts };
    });
    committed = true;
    await database.transaction(async (sql) => {
      const receipt = (
        await sql.query(
          "SELECT source_digest FROM cloud_imports WHERE source_id=$1",
          [source.sourceId],
        )
      ).rows[0];
      if (receipt?.source_digest !== source.digest)
        throw new Error(
          "The committed import could not be verified. The source has been retained.",
        );
      await verifyImportedIdentity(
        sql,
        source,
        result.userId,
        result.organizationId,
      );
    });
    source.connection.exec("COMMIT");
    const checkpoint = source.connection
      .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    if (checkpoint?.busy !== 0)
      throw new Error(
        "Another process is using the source database. Stop it before retrying cleanup.",
      );
    source.connection.close();
    const cleaned =
      cleanSourceFiles(source) &&
      (await finishImportCleanup(database, source.sourceId));
    return { ...result, cleaned };
  } catch (error) {
    try {
      source.connection.close();
    } catch (closeError) {
      if (!committed)
        console.error(
          "Migration source close failed:",
          closeError instanceof Error ? closeError.message : "Unknown error",
        );
    }
    throw error;
  }
}

function migratedRows(
  source: LegacySource,
  table: (typeof importTables)[number],
  encodedKey: string,
): ImportRow[] {
  const cipher = cloudCredentialsCipher(encodedKey)!;
  return source.tables[table].map((original) => {
    const row = { ...original };
    if (table === "settings_profiles" || table === "settings_profile_versions")
      row.document_json = JSON.stringify(
        validateSettingsDocument(
          JSON.parse(String(row.document_json)),
          source.config.settingsManager.limits,
        ),
      );
    let field: string | undefined;
    let context: Buffer | undefined;
    if (table === "settings_secrets") {
      field = "ciphertext";
      context = Buffer.from(`${row.profile_id}\0${row.secret_id}`);
    } else if (table === "enrollment_settings") {
      field = "document_ciphertext";
      context = Buffer.from(
        `machdoch/enrollment-settings/${source.sourceId}/${row.instance_id}`,
      );
    } else if (table === "metadata" && row.key === "settings_key_check_v1") {
      if (!source.cipher)
        throw new Error("The source settings encryption key is required.");
      const context = Buffer.from("machdoch/settings/key-check/v1");
      const plaintext = source.cipher.decrypt(
        Buffer.from(String(row.value), "base64url"),
        context,
      );
      if (!plaintext.equals(Buffer.from("machdoch-settings-manager-key-v1")))
        throw new Error("The source settings key check is invalid.");
      row.value = cipher.encrypt(plaintext, context).toString("base64url");
    }
    if (field && context) {
      const encrypted = row[field];
      if (!source.cipher || !(encrypted instanceof Uint8Array))
        throw new Error("The source contains an unreadable encrypted setting.");
      const plaintext = source.cipher.decrypt(Buffer.from(encrypted), context);
      if (table === "enrollment_settings")
        validateSettingsDocument(
          JSON.parse(plaintext.toString("utf8")),
          source.config.settingsManager.limits,
        );
      const reencrypted = cipher.encrypt(plaintext, context);
      row[field] = reencrypted;
      if (!cipher.decrypt(reencrypted, context).equals(plaintext))
        throw new Error("Secret verification failed.");
    }
    return row;
  });
}

async function verifyImportedIdentity(
  sql: CloudSql,
  source: LegacySource,
  userId: string,
  organizationId: string,
): Promise<void> {
  const user = (
    await sql.query("SELECT password_hash FROM cloud_users WHERE id=$1", [
      userId,
    ])
  ).rows[0];
  const membership = (
    await sql.query(
      "SELECT role FROM cloud_memberships WHERE user_id=$1 AND organization_id=$2",
      [userId, organizationId],
    )
  ).rows[0];
  if (
    user?.password_hash !== source.owner.password_hash ||
    membership?.role !== "owner"
  )
    throw new Error(
      "Imported account verification failed. The source has been retained.",
    );
}

function cleanSourceFiles(source: LegacySource): boolean {
  const { path } = source;
  try {
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      realpathSync(path) !== path
    )
      throw new Error("The migration source path changed before cleanup.");
    const identity = lstatSync(path, { bigint: true });
    if (
      identity.dev !== source.identity.device ||
      identity.ino !== source.identity.inode
    )
      throw new Error("The migration source file was replaced before cleanup.");
    for (const target of [
      `${path}-wal`,
      `${path}-shm`,
      `${path}-journal`,
      path,
    ]) {
      if (!existsSync(target)) continue;
      if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())
        throw new Error("A migration cleanup path is not a regular file.");
      unlinkSync(target);
    }
    return true;
  } catch (error) {
    console.error(
      "Import completed; source cleanup will be retried at startup:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return false;
  }
}
