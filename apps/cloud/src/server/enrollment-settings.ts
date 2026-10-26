import { type FleetDatabase, requiredNumber, requiredString } from "./database";
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

export async function captureEnrollmentSettings(
  database: FleetDatabase,
  cipher: SettingsCipher,
  instanceId: string,
  document: ManagedSettingsDocument,
  now: number,
): Promise<void> {
  await database.transaction(async () => {
    if (
      await database.get(
        "SELECT instance_id FROM enrollment_settings WHERE instance_id = $1",
        instanceId,
      )
    )
      return;
    await database.run(
      "INSERT INTO enrollment_settings (instance_id, document_ciphertext, captured_at) VALUES ($1, $2, $3)",
      instanceId,
      cipher.encrypt(
        Buffer.from(JSON.stringify(document)),
        await associatedData(database, instanceId),
      ),
      now,
    );
    await database.audit(
      now,
      "enrollment_settings.captured",
      instanceId,
      "success",
    );
  });
}

export async function listEnrollmentSettings(
  database: FleetDatabase,
): Promise<
  Array<{ instanceId: string; displayName: string; capturedAt: number }>
> {
  return (
    await database.all(
      "SELECT e.instance_id, i.display_name, e.captured_at FROM enrollment_settings e JOIN instances i ON i.instance_id = e.instance_id WHERE i.revoked_at IS NULL ORDER BY lower(i.display_name)",
    )
  ).map((row) => ({
    instanceId: requiredString(row, "instance_id"),
    displayName: requiredString(row, "display_name"),
    capturedAt: requiredNumber(row, "captured_at"),
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
