import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  MimoriiAdministration,
  MimoriiSettings,
  MimoriiSettingsInput,
} from "../../../lib/cloud-activity-contract";
import type { SettingsCipher } from "../../settings-crypto";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
} from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import {
  MimoriiDeliveryError,
  mimoriiTestBatch,
  sendMimoriiBatch,
} from "./mimorii-protocol";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const settingsColumns = `c.url,c.token_prefix AS "tokenPrefix",c.enabled,c.revision,
  to_char(c.connected_at AT TIME ZONE 'UTC',${timestamp}) AS "connectedAt",
  to_char(c.delivered_at AT TIME ZONE 'UTC',${timestamp}) AS "deliveredAt",
  c.delivered_entries::double precision AS "deliveredEntries",c.rejected_entries::double precision AS "rejectedEntries",c.last_error AS "lastError",
  CASE WHEN c.failures>0 THEN to_char(c.retry_at AT TIME ZONE 'UTC',${timestamp}) END AS "retryAt",
  (SELECT count(*)::integer FROM cloud_ai_activity a WHERE a.organization_id=c.organization_id AND a.exported_at IS NULL AND a.occurred_at>=c.connected_at) AS pending`;

function secretContext(organizationId: string, url: string): Buffer {
  return Buffer.from(
    JSON.stringify({ kind: "cloud.mimorii", organizationId, url }),
  );
}

export interface MimoriiConnection {
  url: string;
  token: string;
  revision: number;
}

export async function mimoriiConnection(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  organizationId: string,
): Promise<MimoriiConnection> {
  const storage = await requireCredentialStorage(sql, cipher);
  const row = (
    await sql.query<{ url: string; secret: Uint8Array; revision: number }>(
      "SELECT url,secret,revision FROM cloud_mimorii_connections WHERE organization_id=$1",
      [organizationId],
    )
  ).rows[0];
  if (!row)
    throw new CloudError(409, "mimorii_unconfigured", "Connect Mimorii first.");
  try {
    return {
      url: row.url,
      revision: row.revision,
      token: storage
        .decrypt(
          Buffer.from(row.secret),
          secretContext(organizationId, row.url),
        )
        .toString("utf8"),
    };
  } catch {
    throw new CloudError(
      503,
      "credential_storage",
      "The Mimorii token cannot be unlocked. Enter it again.",
    );
  }
}

export async function readMimoriiSettings(
  sql: CloudSql,
  organizationId: string,
): Promise<MimoriiSettings | null> {
  return (
    (
      await sql.query<MimoriiSettings & Record<string, unknown>>(
        `SELECT ${settingsColumns} FROM cloud_mimorii_connections c WHERE c.organization_id=$1`,
        [organizationId],
      )
    ).rows[0] ?? null
  );
}

export class CloudMimoriiConnections {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch = fetch,
  ) {}

  get(actor: CloudActor): Promise<MimoriiAdministration> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return {
        settings: await readMimoriiSettings(sql, actor.organizationId),
        credentialStorageAvailable: this.cipher !== null,
      };
    });
  }

  save(
    actor: CloudActor,
    key: string,
    input: MimoriiSettingsInput,
  ): Promise<{ revision: number }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const cipher = await requireCredentialStorage(sql, this.cipher);
      return command(
        sql,
        actor,
        key,
        {
          kind: "mimorii.settings",
          input: {
            ...input,
            token:
              input.token === undefined
                ? undefined
                : cipher.fingerprint(
                    Buffer.from(input.token),
                    Buffer.from(
                      `cloud.mimorii.command/${actor.organizationId}`,
                    ),
                  ),
          },
        },
        async () => {
          const current = (
            await sql.query<{
              url: string;
              secret: Uint8Array;
              enabled: boolean;
              revision: number;
              token_prefix: string;
            }>(
              "SELECT url,secret,enabled,revision,token_prefix FROM cloud_mimorii_connections WHERE organization_id=$1 FOR UPDATE",
              [actor.organizationId],
            )
          ).rows[0];
          checkRevision(current?.revision ?? 0, input.revision);
          const urlChanged = current?.url !== input.url;
          if (input.token === undefined && (!current || urlChanged))
            throw new CloudError(
              422,
              "mimorii_token_required",
              "Enter the Mimorii log source token for this address.",
            );
          if (
            current &&
            !urlChanged &&
            current.enabled === input.enabled &&
            input.token === undefined
          )
            return { revision: current.revision };
          const restart =
            !current ||
            urlChanged ||
            input.token !== undefined ||
            (input.enabled && !current.enabled);
          const secret =
            input.token === undefined
              ? Buffer.from(current!.secret)
              : cipher.encrypt(
                  Buffer.from(input.token),
                  secretContext(actor.organizationId, input.url),
                );
          const updated = (
            await sql.query<{ revision: number }>(
              `INSERT INTO cloud_mimorii_connections (organization_id,url,secret,token_prefix,enabled) VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (organization_id) DO UPDATE SET url=$2,secret=$3,token_prefix=$4,enabled=$5,revision=cloud_mimorii_connections.revision+1,
              connected_at=CASE WHEN $6 THEN clock_timestamp() ELSE cloud_mimorii_connections.connected_at END,
              failures=CASE WHEN $6 THEN 0 ELSE cloud_mimorii_connections.failures END,
              last_error=CASE WHEN $6 THEN NULL ELSE cloud_mimorii_connections.last_error END,
              retry_at=CASE WHEN $6 THEN clock_timestamp() ELSE cloud_mimorii_connections.retry_at END
              RETURNING revision`,
              [
                actor.organizationId,
                input.url,
                secret,
                input.token?.slice(0, 16) ?? current!.token_prefix,
                input.enabled,
                restart,
              ],
            )
          ).rows[0]!;
          await recordEvent(
            sql,
            actor,
            "mimorii.settings_changed",
            actor.organizationId,
            updated.revision,
            { enabled: input.enabled, tokenChanged: input.token !== undefined },
          );
          return updated;
        },
      );
    });
  }

  remove(actor: CloudActor, revision: number): Promise<{ ok: true }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const current = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_mimorii_connections WHERE organization_id=$1 FOR UPDATE",
          [actor.organizationId],
        )
      ).rows[0];
      if (!current)
        throw new CloudError(404, "not_found", "Mimorii is not connected.");
      checkRevision(current.revision, revision);
      await sql.query(
        "DELETE FROM cloud_mimorii_connections WHERE organization_id=$1",
        [actor.organizationId],
      );
      await recordEvent(
        sql,
        actor,
        "mimorii.disconnected",
        actor.organizationId,
        current.revision + 1,
        {},
      );
      return { ok: true };
    });
  }

  async test(actor: CloudActor): Promise<{ accepted: number }> {
    const connection = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return mimoriiConnection(sql, this.cipher, actor.organizationId);
    });
    const identity = await this.database.transaction(
      async (sql) =>
        (
          await sql.query<{ name: string; at: string }>(
            `SELECT name,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM cloud_users WHERE id=$1`,
            [actor.userId],
          )
        ).rows[0]!,
    );
    try {
      const result = await sendMimoriiBatch(
        connection.url,
        connection.token,
        mimoriiTestBatch(identity.name, identity.at),
        this.transport,
      );
      if (result.rejection)
        throw new CloudError(502, "mimorii_rejected", result.rejection);
      return { accepted: result.accepted };
    } catch (error) {
      if (error instanceof MimoriiDeliveryError)
        throw new CloudError(502, "mimorii_unavailable", error.message);
      throw error;
    }
  }
}
