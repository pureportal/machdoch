import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  MagicLinkPreview,
  MagicLinkRequest,
} from "../../../lib/cloud-email-contract";
import {
  createSecret,
  hashSecret,
  validateSecret,
  verifySecret,
} from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, recordEvent } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { issueCloudSession, lockUserSessions } from "../session-issuance";
import type { CloudSessionContext } from "./session-context";

export const magicPayloadContext = (id: string): Buffer =>
  Buffer.from(`machdoch.cloud/magic-link/${id}`);
const unavailable = () =>
  new CloudError(
    401,
    "magic_link_unavailable",
    "This sign-in link is unavailable. Request a new link.",
  );

interface LinkRecord extends Record<string, unknown> {
  id: string;
  organization_id: string;
  user_id: string;
  authorization_id: string | null;
  consumed_at: Date | null;
}
interface ValidLink extends LinkRecord {
  email: string;
  organization: string;
}

async function readValidLink(
  sql: CloudSql,
  id: string,
  completed = false,
): Promise<ValidLink> {
  const link = (
    await sql.query<LinkRecord>(
      "SELECT id,organization_id,user_id,authorization_id,consumed_at FROM cloud_magic_links WHERE id=$1 AND (consumed_at IS NULL OR $2) AND expires_at>clock_timestamp() FOR UPDATE",
      [id, completed],
    )
  ).rows[0];
  if (!link?.user_id) throw unavailable();
  const user = (
    await sql.query<{ email: string }>(
      "SELECT u.email FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.organization_id=$2 AND m.active AND NOT u.disabled AND GREATEST(u.authentication_epoch,m.authentication_epoch)<=(SELECT generation FROM cloud_magic_links WHERE id=$3) FOR SHARE OF u,m",
      [link.user_id, link.organization_id, link.id],
    )
  ).rows[0];
  const setting = (
    await sql.query<{ organization: string }>(
      "SELECT o.name AS organization FROM cloud_email_settings s JOIN cloud_organizations o ON o.id=s.organization_id WHERE s.organization_id=$1 AND s.enabled AND s.signin_epoch<=(SELECT generation FROM cloud_magic_links WHERE id=$2) AND cloud_email_signin_valid(s.organization_id,(SELECT generation FROM cloud_magic_links WHERE id=$2)) FOR SHARE OF s",
      [link.organization_id, link.id],
    )
  ).rows[0];
  if (!user || !setting) throw unavailable();
  return { ...link, email: user.email, organization: setting.organization };
}

interface Confirmation extends Record<string, unknown> {
  link_id: string;
  nonce_hash: string;
  receipt: Uint8Array | null;
  session_hash: string | null;
}
async function confirmationReference(
  sql: CloudSql,
  id: string,
  nonce: string,
): Promise<Confirmation> {
  if (!validateSecret(nonce, "mch_cloud_confirmation")) throw unavailable();
  const reference = (
    await sql.query<Confirmation>(
      "SELECT link_id,nonce_hash,receipt,session_hash FROM cloud_magic_confirmations WHERE id=$1 AND expires_at>clock_timestamp()",
      [id],
    )
  ).rows[0];
  if (!reference || !verifySecret(nonce, reference.nonce_hash))
    throw unavailable();
  return reference;
}
async function readConfirmation(
  sql: CloudSql,
  id: string,
  nonce: string,
): Promise<{ link: ValidLink; confirmation: Confirmation }> {
  const reference = await confirmationReference(sql, id, nonce);
  const link = await readValidLink(sql, reference.link_id, true);
  const confirmation = (
    await sql.query<Confirmation>(
      "SELECT link_id,nonce_hash,receipt,session_hash FROM cloud_magic_confirmations WHERE id=$1 AND link_id=$2 AND nonce_hash=$3 AND expires_at>clock_timestamp() FOR UPDATE",
      [id, link.id, reference.nonce_hash],
    )
  ).rows[0];
  if (!confirmation || !!link.consumed_at !== !!confirmation.receipt)
    throw unavailable();
  if (
    confirmation.receipt &&
    !(
      await sql.query(
        "SELECT token_hash FROM cloud_sessions WHERE token_hash=$1 AND user_id=$2 AND organization_id=$3 AND expires_at>clock_timestamp() AND touched_at>clock_timestamp()-interval '30 minutes'",
        [confirmation.session_hash, link.user_id, link.organization_id],
      )
    ).rows.length
  )
    throw unavailable();
  return { link, confirmation };
}

const sessionReceiptSchema = z.strictObject({
  sessionToken: z
    .string()
    .refine((value) => validateSecret(value, "mch_cloud_session")),
  csrfToken: z
    .string()
    .refine((value) => validateSecret(value, "mch_cloud_csrf")),
});
function receiptContext(id: string, nonceHash: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: "cloud.magic.confirmation",
      id: id.toLowerCase(),
      nonceHash,
    }),
  );
}

async function preview(
  sql: CloudSql,
  link: ValidLink,
  confirmationId: string,
  actor?: CloudActor | null,
): Promise<MagicLinkPreview> {
  const current =
    actor && actor.userId !== link.user_id
      ? (
          await sql.query<{ email: string }>(
            "SELECT email FROM cloud_users WHERE id=$1 AND NOT disabled",
            [actor.userId],
          )
        ).rows[0]
      : undefined;
  return {
    confirmationId,
    email: link.email,
    organization: link.organization,
    currentEmail: current?.email ?? null,
  };
}

export class CloudMagicLinks {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
  ) {}

  available(): Promise<boolean> {
    if (!this.cipher) return Promise.resolve(false);
    return this.database.transaction(
      async (sql) =>
        (
          await sql.query(
            "SELECT organization_id FROM cloud_email_settings WHERE enabled AND NOT EXISTS(SELECT 1 FROM cloud_signin_policies p WHERE p.organization_id=cloud_email_settings.organization_id AND p.required_sso) LIMIT 1",
          )
        ).rows.length > 0,
    );
  }

  request(input: MagicLinkRequest): Promise<void> {
    return this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      if (
        !(
          await sql.query(
            "SELECT organization_id FROM cloud_email_settings WHERE enabled AND NOT EXISTS(SELECT 1 FROM cloud_signin_policies p WHERE p.organization_id=cloud_email_settings.organization_id AND p.required_sso) LIMIT 1",
          )
        ).rows.length
      )
        throw new CloudError(
          503,
          "email_signin_disabled",
          "Email sign-in is unavailable. Use your password or contact your administrator.",
        );
      const id = randomUUID(),
        token = createSecret("mch_cloud_magic");
      const payload = cipher.encrypt(
        Buffer.from(JSON.stringify({ email: input.email, token })),
        magicPayloadContext(id),
      );
      await sql.query(
        "INSERT INTO cloud_magic_links (id,token_hash,authorization_id,requested_organization_id,payload) VALUES ($1,$2,$3,$4,$5)",
        [
          id,
          hashSecret(token),
          input.authorizationId ?? null,
          input.organizationId ?? null,
          payload,
        ],
      );
    });
  }

  prepare(
    token: string,
    actor?: CloudActor | null,
    previousNonce?: string,
  ): Promise<{ preview: MagicLinkPreview; nonce: string }> {
    if (!validateSecret(token, "mch_cloud_magic"))
      return Promise.reject(unavailable());
    return this.database.transaction(async (sql) => {
      const reference = (
        await sql.query<{ id: string }>(
          "SELECT id FROM cloud_magic_links WHERE token_hash=$1",
          [hashSecret(token)],
        )
      ).rows[0];
      if (!reference) throw unavailable();
      const link = await readValidLink(sql, reference.id);
      await sql.query(
        "DELETE FROM cloud_magic_confirmations WHERE link_id=$1 AND (expires_at<=clock_timestamp() OR id IN (SELECT id FROM cloud_magic_confirmations WHERE link_id=$1 ORDER BY created_at DESC,id OFFSET 4))",
        [link.id],
      );
      const reusable =
        previousNonce &&
        validateSecret(previousNonce, "mch_cloud_confirmation") &&
        (
          await sql.query(
            "SELECT id FROM cloud_magic_confirmations WHERE nonce_hash=$1 AND expires_at>clock_timestamp() LIMIT 1",
            [hashSecret(previousNonce)],
          )
        ).rows.length > 0;
      const id = randomUUID(),
        nonce = reusable
          ? previousNonce!
          : createSecret("mch_cloud_confirmation");
      const created = await sql.query(
        "INSERT INTO cloud_magic_confirmations (id,link_id,nonce_hash,expires_at) SELECT $1,id,$3,LEAST(expires_at,clock_timestamp()+interval '5 minutes') FROM cloud_magic_links WHERE id=$2 AND expires_at>clock_timestamp() RETURNING id",
        [id, link.id, hashSecret(nonce)],
      );
      if (!created.rows.length) throw unavailable();
      return { preview: await preview(sql, link, id, actor), nonce };
    });
  }

  inspect(
    confirmationId: string,
    nonce: string,
    actor?: CloudActor | null,
  ): Promise<MagicLinkPreview> {
    return this.database.transaction(async (sql) =>
      preview(
        sql,
        (await readConfirmation(sql, confirmationId, nonce)).link,
        confirmationId,
        actor,
      ),
    );
  }

  consume(
    confirmationId: string,
    nonce: string,
    previousToken?: string,
    context?: CloudSessionContext,
  ): Promise<{ sessionToken: string; csrfToken: string; redirect: string }> {
    return this.database.transaction(async (sql) => {
      await confirmationReference(sql, confirmationId, nonce);
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const { link, confirmation } = await readConfirmation(
        sql,
        confirmationId,
        nonce,
      );
      const redirect = link.authorization_id
        ? `/cloud/authorize?requestId=${link.authorization_id}`
        : "/cloud/issues";
      if (confirmation.receipt) {
        const session = sessionReceiptSchema.parse(
          JSON.parse(
            cipher
              .decrypt(
                Buffer.from(confirmation.receipt),
                receiptContext(confirmationId, confirmation.nonce_hash),
              )
              .toString("utf8"),
          ),
        );
        if (hashSecret(session.sessionToken) !== confirmation.session_hash)
          throw unavailable();
        const previous = previousToken
          ? (
              await sql.query<{ user_id: string }>(
                "SELECT user_id FROM cloud_sessions WHERE token_hash=$1",
                [hashSecret(previousToken)],
              )
            ).rows[0]
          : undefined;
        await lockUserSessions(sql, [
          link.user_id,
          ...(previous ? [previous.user_id] : []),
        ]);
        if (
          !(
            await sql.query(
              "SELECT token_hash FROM cloud_sessions s WHERE token_hash=$1 AND cloud_session_active(s)",
              [confirmation.session_hash],
            )
          ).rows.length
        )
          throw unavailable();
        if (
          previousToken &&
          hashSecret(previousToken) !== confirmation.session_hash
        )
          await sql.query("DELETE FROM cloud_sessions WHERE token_hash=$1", [
            hashSecret(previousToken),
          ]);
        return { ...session, redirect };
      }
      const consumed = await sql.query(
        "UPDATE cloud_magic_links SET consumed_at=clock_timestamp(),payload=NULL,delivery_state='discarded',delivery_lease=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() AND EXISTS (SELECT 1 FROM cloud_magic_confirmations WHERE id=$2 AND expires_at>clock_timestamp()) RETURNING id",
        [link.id, confirmationId],
      );
      if (!consumed.rows.length) throw unavailable();
      await sql.query(
        "DELETE FROM cloud_magic_confirmations WHERE link_id=$1 AND id<>$2",
        [link.id, confirmationId],
      );
      const session = await issueCloudSession(
        sql,
        link.user_id,
        "magic_link",
        link.organization_id,
        previousToken,
        undefined,
        context,
      );
      await sql.query(
        "UPDATE cloud_magic_confirmations SET receipt=$2,session_hash=$3,consumed_at=clock_timestamp() WHERE id=$1",
        [
          confirmationId,
          cipher.encrypt(
            Buffer.from(JSON.stringify(session)),
            receiptContext(confirmationId, confirmation.nonce_hash),
          ),
          hashSecret(session.sessionToken),
        ],
      );
      await recordEvent(
        sql,
        { userId: link.user_id, organizationId: link.organization_id },
        "session.magic_link",
        link.user_id,
        1,
        {},
      );
      return {
        ...session,
        redirect,
      };
    });
  }
}
