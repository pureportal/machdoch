import {
  type FleetDatabase,
  optionalNumber,
  requiredNumber,
  requiredString,
} from "./database";
import type { SettingsCipher } from "./settings-crypto";
import {
  validateSettingsDocument,
  type ManagedSettingsDocument,
} from "./settings";
import type { CloudServerConfig } from "./config";

const associatedData = async (
  database: FleetDatabase,
  instanceId: string,
): Promise<Buffer> =>
  Buffer.from(
    `machdoch/enrollment-settings/${await database.managerId()}/${instanceId}`,
  );

/**
 * Legacy capture: stores the first snapshot and ignores later uploads unless
 * an administrator requested a fresh one.
 */
export async function captureEnrollmentSettings(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  document: ManagedSettingsDocument,
  now: number,
): Promise<void> {
  await database.transaction(async () => {
    if (!(await snapshotStatus(database, instanceId)).requested) return;
    await storeSnapshot(database, cipher, instanceId, document, now);
  });
}

/** Replaces the device snapshot and clears a pending refresh request. */
export async function uploadSnapshotSettings(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  document: ManagedSettingsDocument,
  now: number,
): Promise<void> {
  await database.transaction(() =>
    storeSnapshot(database, cipher, instanceId, document, now),
  );
}

async function storeSnapshot(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  document: ManagedSettingsDocument,
  now: number,
): Promise<void> {
  const existed = Boolean(
    await database.get(
      "SELECT instance_id FROM enrollment_settings WHERE instance_id = $1",
      instanceId,
    ),
  );
  await database.run(
    "INSERT INTO enrollment_settings (instance_id, document_ciphertext, captured_at) VALUES ($1, $2, $3)\n     ON CONFLICT (instance_id) DO UPDATE SET\n       document_ciphertext = excluded.document_ciphertext,\n       captured_at = excluded.captured_at",
    instanceId,
    cipher.encrypt(
      Buffer.from(JSON.stringify(document)),
      await associatedData(database, instanceId),
    ),
    now,
  );
  await database.run(
    "DELETE FROM settings_snapshot_requests WHERE instance_id = $1",
    instanceId,
  );
  await database.audit(
    now,
    existed ? "enrollment_settings.updated" : "enrollment_settings.captured",
    instanceId,
    "success",
  );
}

/** `requested` when no snapshot exists yet or an administrator asked for a new one. */
export async function snapshotStatus(
  database: FleetDatabase,
  instanceId: string,
): Promise<{ capturedAt: number | null; requested: boolean }> {
  const row = await database.get(
    "SELECT e.captured_at, r.requested_at\n     FROM instances i\n     LEFT JOIN enrollment_settings e ON e.instance_id = i.instance_id\n     LEFT JOIN settings_snapshot_requests r ON r.instance_id = i.instance_id\n     WHERE i.instance_id = $1",
    instanceId,
  );
  const capturedAt = row ? optionalNumber(row, "captured_at") : null;
  return {
    capturedAt,
    requested: capturedAt === null || (row?.requested_at ?? null) !== null,
  };
}

export async function requestSnapshotRefresh(
  database: FleetDatabase,
  instanceId: string,
  now: number,
): Promise<void> {
  await database.transaction(async () => {
    await database.run(
      "INSERT INTO settings_snapshot_requests (instance_id, requested_at) VALUES ($1, $2)\n       ON CONFLICT (instance_id) DO UPDATE SET requested_at = excluded.requested_at",
      instanceId,
      now,
    );
    await database.audit(
      now,
      "enrollment_settings.refresh_requested",
      instanceId,
      "success",
    );
  });
}

export async function listEnrollmentSettings(database: FleetDatabase): Promise<
  Array<{
    instanceId: string;
    displayName: string;
    capturedAt: number;
    refreshRequestedAt: number | null;
  }>
> {
  return (
    await database.all(
      "SELECT e.instance_id, i.display_name, e.captured_at, r.requested_at FROM enrollment_settings e JOIN instances i ON i.instance_id = e.instance_id LEFT JOIN settings_snapshot_requests r ON r.instance_id = e.instance_id WHERE i.revoked_at IS NULL ORDER BY lower(i.display_name)",
    )
  ).map((row) => ({
    instanceId: requiredString(row, "instance_id"),
    displayName: requiredString(row, "display_name"),
    capturedAt: requiredNumber(row, "captured_at"),
    refreshRequestedAt: optionalNumber(row, "requested_at"),
  }));
}

export async function readEnrollmentSettings(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  limits: CloudServerConfig["settingsManager"]["limits"],
): Promise<ManagedSettingsDocument | null> {
  const row = await database.get(
    "SELECT document_ciphertext FROM enrollment_settings WHERE instance_id = $1",
    instanceId,
  );
  if (!row) return null;
  if (!(row.document_ciphertext instanceof Uint8Array))
    throw new Error("Enrollment settings are invalid.");
  const plaintext = cipher.decrypt(
    Buffer.from(row.document_ciphertext),
    await associatedData(database, instanceId),
  );
  return validateSettingsDocument(
    JSON.parse(plaintext.toString("utf8")),
    limits,
  );
}
