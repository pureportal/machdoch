import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudEmailAdministration,
  CloudEmailSettings,
  EmailSettingsInput,
  MailFailureCode,
} from "../../../lib/cloud-email-contract";
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

export interface SmtpConnection {
  host: string;
  port: number;
  security: "tls" | "starttls";
  tlsName: string | null;
  username: string | null;
  password: string | null;
  from: string;
}
export const emailSettingsColumns =
  'host,port,security,tls_name AS "tlsName",username,from_address AS "from",enabled,revision,(secret IS NOT NULL) AS "hasPassword"';
type EmailSettingsRow = CloudEmailSettings & { secret: Uint8Array | null };

function secretContext(
  organizationId: string,
  input: Pick<
    SmtpConnection,
    "host" | "port" | "security" | "tlsName" | "username"
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: "cloud.smtp",
      organizationId,
      host: input.host,
      port: input.port,
      security: input.security,
      tlsName: input.tlsName,
      username: input.username,
    }),
  );
}

export async function smtpConnection(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  organizationId: string,
  expectedRevision?: number,
): Promise<SmtpConnection> {
  const storage = await requireCredentialStorage(sql, cipher);
  const row = (
    await sql.query<EmailSettingsRow & Record<string, unknown>>(
      `SELECT ${emailSettingsColumns},secret FROM cloud_email_settings WHERE organization_id=$1 FOR SHARE`,
      [organizationId],
    )
  ).rows[0];
  if (!row)
    throw new CloudError(
      409,
      "email_unconfigured",
      "Configure an email server first.",
    );
  if (expectedRevision !== undefined)
    checkRevision(row.revision, expectedRevision);
  let password = null;
  if (row.secret) {
    try {
      password = storage
        .decrypt(Buffer.from(row.secret), secretContext(organizationId, row))
        .toString("utf8");
    } catch {
      throw new CloudError(
        503,
        "credential_storage",
        "Email credentials cannot be unlocked. Contact your administrator.",
      );
    }
  }
  return {
    host: row.host,
    port: row.port,
    security: row.security,
    tlsName: row.tlsName,
    username: row.username,
    password,
    from: row.from,
  };
}

export class CloudEmailSettingsService {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
  ) {}

  get(actor: CloudActor): Promise<CloudEmailAdministration> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const settings =
        (
          await sql.query<CloudEmailSettings & Record<string, unknown>>(
            `SELECT ${emailSettingsColumns} FROM cloud_email_settings WHERE organization_id=$1`,
            [actor.organizationId],
          )
        ).rows[0] ?? null;
      const failures = (
        await sql.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM cloud_magic_links WHERE organization_id=$1 AND delivery_state='failed' AND delivery_settings_revision=$2 AND created_at>now()-interval '1 day'",
          [actor.organizationId, settings?.revision ?? 0],
        )
      ).rows[0]!.count;
      const last = (
        await sql.query<{ last_error: MailFailureCode | null }>(
          "SELECT last_error FROM cloud_magic_links WHERE organization_id=$1 AND delivery_state='failed' AND delivery_settings_revision=$2 ORDER BY updated_at DESC,id LIMIT 1",
          [actor.organizationId, settings?.revision ?? 0],
        )
      ).rows[0];
      return {
        settings,
        credentialStorageAvailable: this.cipher !== null,
        failedDeliveries: failures,
        lastError: last?.last_error ?? null,
      };
    });
  }

  save(
    actor: CloudActor,
    key: string,
    input: EmailSettingsInput,
  ): Promise<{ revision: number }> {
    return this.database.transaction(async (sql) => {
      if ((await requireMembership(sql, actor, "admin")) !== "owner")
        throw new CloudError(
          403,
          "owner_required",
          "Only an owner can change email sign-in settings.",
        );
      const cipher = await requireCredentialStorage(sql, this.cipher);
      return command(
        sql,
        actor,
        key,
        {
          kind: "email.settings",
          input: {
            ...input,
            password:
              input.password === undefined
                ? undefined
                : cipher.fingerprint(
                    Buffer.from(input.password),
                    Buffer.from(`cloud.smtp.command/${actor.organizationId}`),
                  ),
          },
        },
        async () => {
          const current = (
            await sql.query<EmailSettingsRow & Record<string, unknown>>(
              `SELECT ${emailSettingsColumns},secret FROM cloud_email_settings WHERE organization_id=$1 FOR UPDATE`,
              [actor.organizationId],
            )
          ).rows[0];
          checkRevision(current?.revision ?? 0, input.revision);
          const connectionChanged =
            !current ||
            ["host", "port", "security", "tlsName", "username"].some(
              (field) =>
                current[field as keyof EmailSettingsRow] !==
                input[field as keyof EmailSettingsInput],
            );
          if (
            input.username &&
            input.password === undefined &&
            (connectionChanged || !current?.secret)
          )
            throw new CloudError(
              422,
              "email_password_required",
              "Enter the password when changing the email server or username.",
            );
          if (!input.username && input.password !== undefined)
            throw new CloudError(
              422,
              "email_username_required",
              "Enter a username to use a password.",
            );
          const secret = input.username
            ? input.password === undefined
              ? current!.secret
              : cipher.encrypt(
                  Buffer.from(input.password),
                  secretContext(actor.organizationId, input),
                )
            : null;
          if (
            current &&
            !connectionChanged &&
            current.from === input.from &&
            current.enabled === input.enabled &&
            input.password === undefined
          )
            return { revision: current.revision };
          const updated = (
            await sql.query<{ revision: number }>(
              `INSERT INTO cloud_email_settings (organization_id,host,port,security,tls_name,username,secret,from_address,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (organization_id) DO UPDATE SET host=$2,port=$3,security=$4,tls_name=$5,username=$6,secret=$7,from_address=$8,enabled=$9,revision=cloud_email_settings.revision+1 RETURNING revision`,
              [
                actor.organizationId,
                input.host,
                input.port,
                input.security,
                input.tlsName,
                input.username,
                secret,
                input.from,
                input.enabled,
              ],
            )
          ).rows[0]!;
          await recordEvent(
            sql,
            actor,
            "email.settings_changed",
            actor.organizationId,
            updated.revision,
            {
              enabled: input.enabled,
              passwordChanged: input.password !== undefined,
            },
          );
          return updated;
        },
      );
    });
  }

  connection(actor: CloudActor, revision: number): Promise<SmtpConnection> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return smtpConnection(sql, this.cipher, actor.organizationId, revision);
    });
  }
}
