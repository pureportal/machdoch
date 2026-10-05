import { type FleetDatabase, requiredNumber, requiredString } from "./database";
import type { SettingsCipher } from "./settings-crypto";
import {
  validateSettingsDocument,
  type ManagedSettingsDocument,
} from "./settings";
import type { FleetManagerConfig } from "./config";

const associatedData = (database: FleetDatabase, instanceId: string): Buffer =>
  Buffer.from(
    `machdoch/enrollment-settings/${database.managerId()}/${instanceId}`,
  );

export function captureEnrollmentSettings(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  document: ManagedSettingsDocument,
  now: number,
): void {
  database.transaction(() => {
    if (
      database.get(
        "SELECT instance_id FROM enrollment_settings WHERE instance_id = ?",
        instanceId,
      )
    )
      return;
    database.run(
      "INSERT INTO enrollment_settings (instance_id, document_ciphertext, captured_at) VALUES (?, ?, ?)",
      instanceId,
      cipher.encrypt(
        Buffer.from(JSON.stringify(document)),
        associatedData(database, instanceId),
      ),
      now,
    );
    database.audit(now, "enrollment_settings.captured", instanceId, "success");
  });
}

export function listEnrollmentSettings(
  database: FleetDatabase,
): Array<{ instanceId: string; displayName: string; capturedAt: number }> {
  return database
    .all(
      "SELECT e.instance_id, i.display_name, e.captured_at FROM enrollment_settings e JOIN instances i ON i.instance_id = e.instance_id WHERE i.revoked_at IS NULL ORDER BY i.display_name COLLATE NOCASE",
    )
    .map((row) => ({
      instanceId: requiredString(row, "instance_id"),
      displayName: requiredString(row, "display_name"),
      capturedAt: requiredNumber(row, "captured_at"),
    }));
}

export function readEnrollmentSettings(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  limits: FleetManagerConfig["settingsManager"]["limits"],
): ManagedSettingsDocument | null {
  const row = database.get(
    "SELECT document_ciphertext FROM enrollment_settings WHERE instance_id = ?",
    instanceId,
  );
  if (!row) return null;
  if (!(row.document_ciphertext instanceof Uint8Array))
    throw new Error("Enrollment settings are invalid.");
  const plaintext = cipher.decrypt(
    Buffer.from(row.document_ciphertext),
    associatedData(database, instanceId),
  );
  return validateSettingsDocument(
    JSON.parse(plaintext.toString("utf8")),
    limits,
  );
}
