import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadConfig,
  type LegacyServerConfig,
  type CloudServerRuntimeMode,
} from "../config";
import type { SettingsCipher } from "../settings-crypto";
import { cloudCredentialsCipher } from "./credential-storage";
import { importFiles, type ImportFile } from "./legacy-cleanup";

export const importTables = [
  "metadata",
  "enrollment_grants",
  "instances",
  "audit_log",
  "settings_profiles",
  "settings_profile_versions",
  "settings_secrets",
  "settings_assignments",
  "enrollment_settings",
  "fleet_session_routes",
] as const;

export type ImportRow = Record<string, string | number | null | Uint8Array>;
export type ImportTables = Record<(typeof importTables)[number], ImportRow[]>;

export interface LegacySource {
  path: string;
  configPath: string;
  cleanupFiles: ImportFile[];
  identity: { device: bigint; inode: bigint };
  config: LegacyServerConfig;
  cipher: SettingsCipher | null;
  owner: ImportRow;
  tables: ImportTables;
  sourceId: string;
  digest: string;
  connection: DatabaseSync;
}

export function findLegacyConfiguration(explicit?: string): string | undefined {
  if (explicit === "") return undefined;
  const configured = explicit ?? process.env.MACHDOCH_FLEET_MANAGER_CONFIG;
  if (configured) {
    return resolve(configured);
  }
  const candidates = [
    "/config/fleet-manager.json",
    resolve(process.cwd(), "fleet-manager.json"),
    resolve(process.cwd(), "../fleet-manager/fleet-manager.json"),
  ];
  return candidates.find((path): path is string =>
    Boolean(path && existsSync(path)),
  );
}

export function openLegacySource(
  configPath: string,
  mode: CloudServerRuntimeMode,
): LegacySource | null {
  const config = loadConfig(configPath, mode);
  if (!existsSync(config.database.path)) return null;
  if (
    !lstatSync(config.database.path).isFile() ||
    lstatSync(config.database.path).isSymbolicLink()
  )
    throw new Error(
      "The migration source must be a regular SQLite file, not a symbolic link.",
    );
  const path = realpathSync(config.database.path);
  const identity = lstatSync(path, { bigint: true });
  const connection = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
  });
  try {
    connection.exec("PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE");
    if (
      connection.prepare("PRAGMA integrity_check").get()?.integrity_check !==
        "ok" ||
      connection.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error(
        "The migration source failed SQLite integrity checks. Restore a verified backup before retrying.",
      );
    const names = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name));
    const allowed = new Set<string>([
      ...importTables,
      "owner",
      "owner_sessions",
      "schema_migrations",
      "sqlite_sequence",
    ]);
    if (names.some((name) => !allowed.has(name)))
      throw new Error(
        "The migration source contains unknown tables. No source data was removed.",
      );
    const versions = connection
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    if (
      !versions.length ||
      versions.length > 5 ||
      versions.some((row, index) => row.version !== index + 1)
    )
      throw new Error(
        "The migration source has an unsupported schema version.",
      );
    const requiredTables = importTables.filter((name) =>
      name === "enrollment_settings"
        ? versions.length >= 4
        : name === "fleet_session_routes"
          ? versions.length >= 5
          : true,
    );
    if (requiredTables.some((name) => !names.includes(name)))
      throw new Error(
        "The migration source is missing required tables. Restore a verified backup before retrying.",
      );
    const owners = connection
      .prepare("SELECT * FROM owner")
      .all() as ImportRow[];
    if (owners.length !== 1)
      throw new Error("The migration source must have exactly one owner.");
    const tables = Object.fromEntries(
      importTables.map((name) => [
        name,
        names.includes(name)
          ? connection.prepare(`SELECT * FROM ${name}`).all()
          : [],
      ]),
    ) as ImportTables;
    for (const row of tables.settings_assignments) {
      if ("last_fetched_revision" in row) {
        delete row.last_fetched_revision;
        delete row.last_fetched_at;
        row.last_applied_revision = null;
        row.last_applied_at = null;
      }
      row.last_sync_revision ??= row.last_applied_revision ?? null;
      row.last_sync_attempt_at ??= row.last_applied_at ?? null;
      row.last_sync_error ??= null;
    }
    const sourceId = tables.metadata.find(
      (row) => row.key === "manager_id",
    )?.value;
    if (typeof sourceId !== "string" || !sourceId)
      throw new Error("The migration source has no installation identity.");
    const encrypted =
      tables.settings_secrets.length > 0 ||
      tables.enrollment_settings.length > 0 ||
      tables.metadata.some((row) => row.key === "settings_key_check_v1");
    const cipher = encrypted ? loadLegacySettingsCipher(config) : null;
    if (
      (tables.settings_secrets.length || tables.enrollment_settings.length) &&
      !cipher
    )
      throw new Error(
        "The source encryption key is required to migrate stored secrets.",
      );
    const digest = sourceDigest(owners[0]!, tables, config);
    return {
      path,
      configPath: resolve(configPath),
      cleanupFiles: importFiles(
        configPath,
        config.settingsManager.encryptionKeyFile,
      ),
      identity: { device: identity.dev, inode: identity.ino },
      config,
      cipher,
      owner: owners[0]!,
      tables,
      sourceId,
      digest,
      connection,
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}

export function sourceDigest(
  owner: ImportRow,
  tables: ImportTables,
  config: LegacyServerConfig,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        owner,
        tables: Object.fromEntries(
          importTables.map((table) => [
            table,
            tables[table].map(canonicalRow).sort(),
          ]),
        ),
        config,
      }),
    )
    .digest("hex");
}

export function canonicalRow(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((key) => [
        key,
        row[key] instanceof Uint8Array
          ? Buffer.from(row[key]).toString("base64")
          : row[key],
      ]),
  );
}

function loadLegacySettingsCipher(
  config: LegacyServerConfig,
): SettingsCipher | null {
  if (
    Number(Boolean(config.settingsManager.encryptionKeyFile)) +
      Number(
        Boolean(config.settingsManager.encryptionKeyEnvironmentVariable),
      ) !==
    1
  )
    throw new Error("Specify exactly one source settings encryption key.");
  const value = config.settingsManager.encryptionKeyFile
    ? readFileSync(config.settingsManager.encryptionKeyFile, "utf8").trim()
    : process.env[
        config.settingsManager.encryptionKeyEnvironmentVariable ?? ""
      ]?.trim();
  if (!value)
    throw new Error("The source settings encryption key is required.");
  return cloudCredentialsCipher(value);
}
