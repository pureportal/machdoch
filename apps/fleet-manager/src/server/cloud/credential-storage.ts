import { SettingsCipher } from "../settings-crypto";
import { CloudError } from "./access";
import type { CloudSql } from "./database";

const keyCheckContext = Buffer.from("machdoch.cloud/credential-storage");
const keyCheckPlaintext = Buffer.from(
  "machdoch.cloud/credential-storage/verified",
);

export function cloudCredentialsCipher(
  encoded: string | undefined,
): SettingsCipher | null {
  if (encoded === undefined) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded))
    throw new CloudError(
      503,
      "credential_storage",
      "The cloud credential storage key is invalid.",
    );
  return new SettingsCipher(Buffer.from(encoded, "base64url"));
}

export async function requireCredentialStorage(
  sql: CloudSql,
  cipher: SettingsCipher | null,
): Promise<SettingsCipher> {
  if (!cipher)
    throw new CloudError(
      503,
      "credential_storage",
      "Credential storage is not configured. Contact your administrator.",
    );
  await sql.query("SELECT pg_advisory_xact_lock(1940327613)");
  const stored = (
    await sql.query<{ payload: Uint8Array }>(
      "SELECT payload FROM cloud_credential_key_checks WHERE id=true FOR UPDATE",
    )
  ).rows[0];
  if (stored) {
    try {
      if (
        !cipher
          .decrypt(Buffer.from(stored.payload), keyCheckContext)
          .equals(keyCheckPlaintext)
      )
        throw new Error("Key mismatch");
    } catch {
      throw new CloudError(
        503,
        "credential_storage",
        "Credential storage cannot be unlocked. Contact your administrator.",
      );
    }
  } else
    await sql.query(
      "INSERT INTO cloud_credential_key_checks (id,payload) VALUES (true,$1)",
      [cipher.encrypt(keyCheckPlaintext, keyCheckContext)],
    );
  return cipher;
}
