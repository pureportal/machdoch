import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MailFailureCode } from "../../../lib/cloud-email-contract";
import { hashSecret } from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase } from "../database";
import { magicPayloadContext } from "./magic-links";
import { smtpConnection, type SmtpConnection } from "./email-settings";

const payloadSchema = z.strictObject({
  email: z.email().max(254),
  token: z.string().max(200),
});
export interface MailLease {
  id: string;
  lease: string;
}
export interface SignInMail {
  connection: SmtpConnection;
  recipient: string;
  organization: string;
  url: string;
  messageId: string;
  remainingMs: number;
  connectionFlow: boolean;
}
interface MailRecord extends Record<string, unknown> {
  organization_id: string | null;
  user_id: string | null;
  requested_organization_id: string | null;
  authorization_id: string | null;
  payload: Uint8Array;
  token_hash: string;
}

export class CloudMailStore {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
  ) {}

  async recover(): Promise<void> {
    await this.database.transaction(async (sql) => {
      await sql.query(
        "UPDATE cloud_magic_links SET delivery_state='discarded',payload=NULL,delivery_lease=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE delivery_state IN ('queued','sending') AND (expires_at<=clock_timestamp() OR consumed_at IS NOT NULL)",
      );
      await sql.query(
        "UPDATE cloud_magic_links SET delivery_state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,payload=CASE WHEN attempts>=3 THEN NULL ELSE payload END,delivery_lease=NULL,lease_expires_at=NULL,last_error='timeout',available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE delivery_state='sending' AND lease_expires_at<=clock_timestamp()",
      );
      await sql.query(
        "DELETE FROM cloud_magic_links WHERE expires_at<clock_timestamp()-interval '1 day'",
      );
      await sql.query(
        "DELETE FROM cloud_magic_confirmations WHERE expires_at<=clock_timestamp()",
      );
      await sql.query(
        "DELETE FROM cloud_sessions WHERE token_hash IN (SELECT token_hash FROM cloud_sessions WHERE expires_at<=clock_timestamp() OR touched_at<=clock_timestamp()-interval '30 minutes' ORDER BY token_hash LIMIT 500 FOR UPDATE SKIP LOCKED)",
      );
    });
  }

  claim(): Promise<MailLease | null> {
    return this.database.transaction(async (sql) => {
      const row = (
        await sql.query<{ id: string }>(
          "SELECT id FROM cloud_magic_links WHERE delivery_state='queued' AND attempts<3 AND available_at<=clock_timestamp() AND expires_at>clock_timestamp() AND consumed_at IS NULL ORDER BY available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
      ).rows[0];
      if (!row) return null;
      const lease = randomUUID();
      await sql.query(
        "UPDATE cloud_magic_links SET delivery_state='sending',delivery_lease=$2,lease_expires_at=clock_timestamp()+interval '30 seconds',attempts=attempts+1,updated_at=clock_timestamp() WHERE id=$1",
        [row.id, lease],
      );
      return { id: row.id, lease };
    });
  }

  prepare(lease: MailLease): Promise<SignInMail | null> {
    return this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const row = (
        await sql.query<MailRecord>(
          "SELECT organization_id,user_id,requested_organization_id,authorization_id,payload,token_hash FROM cloud_magic_links WHERE id=$1 AND delivery_lease=$2 AND delivery_state='sending' AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() AND consumed_at IS NULL FOR UPDATE",
          [lease.id, lease.lease],
        )
      ).rows[0];
      if (!row) return null;
      const payload = payloadSchema.parse(
        JSON.parse(
          cipher
            .decrypt(Buffer.from(row.payload), magicPayloadContext(lease.id))
            .toString("utf8"),
        ),
      );
      if (hashSecret(payload.token) !== row.token_hash)
        throw new Error("Invalid mail payload identity");
      const identity = (
        await sql.query<{
          user_id: string;
          organization_id: string;
          settings_revision: number;
          organization: string;
        }>(
          `SELECT u.id AS user_id,m.organization_id,s.revision AS settings_revision,o.name AS organization
        FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id JOIN cloud_email_settings s ON s.organization_id=m.organization_id JOIN cloud_organizations o ON o.id=m.organization_id
        WHERE u.email=$1 AND NOT u.disabled AND m.active AND s.enabled AND ($2::uuid IS NULL OR m.organization_id=$2) AND ($3::uuid IS NULL OR u.id=$3)
        AND GREATEST(u.authentication_epoch,m.authentication_epoch,s.signin_epoch)<=(SELECT generation FROM cloud_magic_links WHERE id=$4)
        AND cloud_email_signin_valid(m.organization_id,(SELECT generation FROM cloud_magic_links WHERE id=$4))
        ORDER BY m.organization_id LIMIT 1 FOR SHARE OF u,m,s`,
          [
            payload.email,
            row.organization_id ?? row.requested_organization_id,
            row.user_id,
            lease.id,
          ],
        )
      ).rows[0];
      if (!identity) {
        await sql.query(
          "UPDATE cloud_magic_links SET delivery_state='discarded',payload=NULL,delivery_lease=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND delivery_lease=$2",
          [lease.id, lease.lease],
        );
        return null;
      }
      const connection = await smtpConnection(
        sql,
        this.cipher,
        identity.organization_id,
        identity.settings_revision,
      );
      const bound = (
        await sql.query<{ remaining_ms: number }>(
          "UPDATE cloud_magic_links SET organization_id=$3,user_id=$4,delivery_settings_revision=$5,updated_at=clock_timestamp() WHERE id=$1 AND delivery_lease=$2 AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() RETURNING floor(extract(epoch FROM LEAST(expires_at,lease_expires_at)-clock_timestamp())*1000)::int AS remaining_ms",
          [
            lease.id,
            lease.lease,
            identity.organization_id,
            identity.user_id,
            identity.settings_revision,
          ],
        )
      ).rows[0];
      if (!bound || bound.remaining_ms <= 0) return null;
      return {
        connection,
        recipient: payload.email,
        organization: identity.organization,
        url: `${this.origin}/cloud/sign-in#${payload.token}`,
        messageId: `<${lease.id}@${new URL(this.origin).hostname}>`,
        remainingMs: bound.remaining_ms,
        connectionFlow: row.authorization_id !== null,
      };
    });
  }

  finish(lease: MailLease, failure: MailFailureCode | null): Promise<boolean> {
    return this.database.transaction(async (sql) => {
      const result = await sql.query(
        `UPDATE cloud_magic_links SET delivery_state=CASE WHEN $3::text IS NULL THEN 'sent' WHEN attempts<3 AND expires_at>clock_timestamp()+interval '10 seconds' THEN 'queued' ELSE 'failed' END,
        payload=CASE WHEN $3::text IS NOT NULL AND attempts<3 AND expires_at>clock_timestamp()+interval '10 seconds' THEN payload ELSE NULL END,
        delivery_lease=NULL,lease_expires_at=NULL,last_error=$3,available_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()
        WHERE id=$1 AND delivery_lease=$2 AND delivery_state='sending' AND lease_expires_at>clock_timestamp() AND consumed_at IS NULL RETURNING id`,
        [lease.id, lease.lease, failure],
      );
      return result.rows.length > 0;
    });
  }
}
