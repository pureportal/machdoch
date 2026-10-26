import { randomBytes } from "node:crypto";
import type { CloudDatabase } from "./database";
import {
  cloudCredentialsCipher,
  requireCredentialStorage,
} from "./credential-storage";
import type { CloudServerConfig } from "../config";

export interface StoredInstallation extends Record<string, unknown> {
  organization_id: string | null;
  origin: string | null;
  credentials_key: string;
  remote_config: Partial<CloudServerConfig>;
}

export async function initializeInstallation(
  database: CloudDatabase,
): Promise<StoredInstallation> {
  return database.transaction(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(1940327612)");
    const existing = (
      await sql.query<StoredInstallation>(
        "SELECT * FROM cloud_installation WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (existing) {
      await requireCredentialStorage(
        sql,
        cloudCredentialsCipher(existing.credentials_key),
      );
      return existing;
    }
    const key =
      process.env.MACHDOCH_CLOUD_ENCRYPTION_KEY ??
      randomBytes(32).toString("base64url");
    await requireCredentialStorage(sql, cloudCredentialsCipher(key));
    const organizations = await sql.query<{ id: string }>(
      "SELECT id FROM cloud_organizations ORDER BY id LIMIT 2",
    );
    const origin = process.env.MACHDOCH_CLOUD_ORIGIN
      ? validateInstallationOrigin(process.env.MACHDOCH_CLOUD_ORIGIN)
      : null;
    return (
      await sql.query<StoredInstallation>(
        "INSERT INTO cloud_installation (id,organization_id,origin,credentials_key) VALUES (1,$1,$2,$3) RETURNING *",
        [
          organizations.rows.length === 1 ? organizations.rows[0]!.id : null,
          origin || null,
          key,
        ],
      )
    ).rows[0]!;
  });
}

export function validateInstallationOrigin(
  value: string,
  development = false,
): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" &&
      !(development && loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("The public address must be an HTTPS origin.");
  return url.origin;
}
