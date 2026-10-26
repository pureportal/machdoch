import type { InvitationPreview } from "../../../lib/cloud-invitation-contract";
import { hashSecret, validateSecret } from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, isCloudError } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudSql } from "../database";
import { flowByBrowser, providerForFlow, type SsoFlow } from "./sso-flow-state";
import type { SsoProviderRow } from "./sso-providers";

export interface InvitationRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  organization: string;
  email: string;
  role: "admin" | "member" | "viewer";
  generation: string;
  invited_by: string;
  authentication: "password" | "oidc";
  provider_id: string | null;
  provider_revision: number | null;
  subject: string | null;
  policy_epoch: string;
  target_user_id: string | null;
  target_membership_epoch: string | null;
  accepted_by: string | null;
  accepted_at: Date | null;
  revoked_at: Date | null;
  live: boolean;
}
export interface InvitationConfirmation extends Record<string, unknown> {
  id: string;
  invitation_id: string;
  browser_hash: string;
  oidc_flow_id: string | null;
  receipt: Uint8Array | null;
  session_hash: string | null;
  confirmed_session_id: string | null;
}
export interface InvitationUser extends Record<string, unknown> {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  authentication_epoch: string;
  disabled: boolean;
}
export interface InvitationSession extends Record<string, unknown> {
  id: string;
  user_id: string;
  organization_id: string;
  email: string;
  authentication_method: string;
}
export function invitationUnavailable(): CloudError {
  return new CloudError(
    410,
    "invitation_unavailable",
    "This invitation is unavailable. Ask for a new invitation.",
  );
}
export function invitationReceiptContext(id: string, browserHash: string) {
  return Buffer.from(
    JSON.stringify(["cloud.invitation.receipt", id.toLowerCase(), browserHash]),
  );
}
export async function invitationLock(sql: CloudSql, organizationId: string) {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `administration:${organizationId}`,
  ]);
}
export async function readInvitation(
  sql: CloudSql,
  id: string,
): Promise<InvitationRow> {
  const row = (
    await sql.query<InvitationRow>(
      "SELECT i.*,o.name AS organization,i.expires_at>clock_timestamp() AS live FROM cloud_invitations i JOIN cloud_organizations o ON o.id=i.organization_id WHERE i.id=$1 FOR UPDATE OF i",
      [id],
    )
  ).rows[0];
  if (!row) throw invitationUnavailable();
  return row;
}
export async function checkPendingInvitation(
  sql: CloudSql,
  invitation: InvitationRow,
): Promise<{ user: InvitationUser | null; provider: SsoProviderRow | null }> {
  await sql.query(
    "SELECT u.id FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.organization_id=$2 FOR SHARE OF u,m",
    [invitation.invited_by, invitation.organization_id],
  );
  await sql.query(
    "SELECT organization_id FROM cloud_signin_policies WHERE organization_id=$1 FOR SHARE",
    [invitation.organization_id],
  );
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "user:" + invitation.email,
  ]);
  const user =
    (
      await sql.query<InvitationUser>(
        "SELECT id,email,name,password_hash,authentication_epoch,disabled FROM cloud_users WHERE email=$1 FOR SHARE",
        [invitation.email],
      )
    ).rows[0] ?? null;
  if (user)
    await sql.query(
      "SELECT user_id FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
      [invitation.organization_id, user.id],
    );
  const provider = invitation.provider_id
    ? ((
        await sql.query<SsoProviderRow>(
          "SELECT * FROM cloud_sso_providers WHERE organization_id=$1 AND id=$2 FOR SHARE",
          [invitation.organization_id, invitation.provider_id],
        )
      ).rows[0] ?? null)
    : null;
  const valid = await sql.query(
    "SELECT id FROM cloud_invitations WHERE id=$1 AND cloud_invitation_pending(cloud_invitations)",
    [invitation.id],
  );
  if (!valid.rows.length) throw invitationUnavailable();
  return { user, provider };
}
export async function loadInvitationConfirmation(
  sql: CloudSql,
  storage: SettingsCipher | null,
  id: string,
  browser: string,
) {
  if (!validateSecret(browser, "mch_cloud_invitation"))
    throw invitationUnavailable();
  const reference = (
    await sql.query<{ invitation_id: string; organization_id: string }>(
      "SELECT c.invitation_id,i.organization_id FROM cloud_invitation_confirmations c JOIN cloud_invitations i ON i.id=c.invitation_id WHERE c.id=$1 AND c.browser_hash=$2 AND c.expires_at>clock_timestamp()",
      [id, hashSecret(browser)],
    )
  ).rows[0];
  if (!reference) throw invitationUnavailable();
  await invitationLock(sql, reference.organization_id);
  const cipher = await requireCredentialStorage(sql, storage);
  const invitation = await readInvitation(sql, reference.invitation_id);
  await sql.query(
    "SELECT id FROM cloud_invitation_confirmations WHERE invitation_id=$1 ORDER BY id FOR UPDATE",
    [invitation.id],
  );
  const confirmation = (
    await sql.query<InvitationConfirmation>(
      "SELECT * FROM cloud_invitation_confirmations WHERE id=$1 AND browser_hash=$2 AND expires_at>clock_timestamp() FOR UPDATE",
      [id, hashSecret(browser)],
    )
  ).rows[0];
  if (!confirmation || (invitation.accepted_at && !confirmation.receipt))
    throw invitationUnavailable();
  return { invitation, confirmation, cipher };
}
export async function currentInvitationSession(
  sql: CloudSql,
  token: string,
): Promise<InvitationSession | null> {
  return (
    (
      await sql.query<InvitationSession>(
        "SELECT s.id,s.user_id,s.organization_id,u.email,s.authentication_method FROM cloud_sessions s JOIN cloud_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND cloud_session_active(s)",
        [hashSecret(token)],
      )
    ).rows[0] ?? null
  );
}
export async function invitationIdentity(
  sql: CloudSql,
  invitation: InvitationRow,
  confirmation: InvitationConfirmation,
  ssoBrowser: string,
): Promise<SsoFlow | null> {
  if (!confirmation.oidc_flow_id) return null;
  const flow = await flowByBrowser(sql, confirmation.oidc_flow_id, ssoBrowser);
  if (
    flow.mode !== "invitation" ||
    flow.invitation_confirmation_id !== confirmation.id ||
    flow.provider_id !== invitation.provider_id ||
    flow.organization_id !== invitation.organization_id
  )
    throw invitationUnavailable();
  await providerForFlow(sql, flow);
  return flow;
}
export async function invitationPreview(
  sql: CloudSql,
  invitation: InvitationRow,
  confirmation: InvitationConfirmation,
  token: string,
  ssoBrowser: string,
): Promise<InvitationPreview> {
  if (!confirmation.receipt) await checkPendingInvitation(sql, invitation);
  else if (
    !(
      await sql.query(
        "SELECT id FROM cloud_sessions s WHERE token_hash=$1 AND cloud_session_active(s)",
        [confirmation.session_hash],
      )
    ).rows.length
  )
    throw invitationUnavailable();
  const current = await currentInvitationSession(sql, token);
  const provider = invitation.provider_id
    ? ((
        await sql.query<{ name: string }>(
          "SELECT configuration->>'name' AS name FROM cloud_sso_providers WHERE id=$1 AND organization_id=$2",
          [invitation.provider_id, invitation.organization_id],
        )
      ).rows[0]?.name ?? null)
    : null;
  let flow: SsoFlow | null = null;
  let failure: InvitationPreview["ssoFailure"] = null;
  if (!confirmation.receipt) {
    try {
      flow = await invitationIdentity(
        sql,
        invitation,
        confirmation,
        ssoBrowser,
      );
    } catch (error) {
      if (!isCloudError(error) || error.code !== "sso_expired") throw error;
      failure = "expired";
    }
  }
  return {
    confirmationId: confirmation.id,
    organization: invitation.organization,
    email: invitation.email,
    role: invitation.role,
    existingAccount: !!invitation.target_user_id,
    authentication: invitation.authentication,
    provider,
    verifiedIdentity:
      flow?.status === "verified" && flow.claims?.subject === invitation.subject
        ? flow.claims.display
        : null,
    currentEmail: current?.email ?? null,
    currentSessionId: current?.id ?? null,
    canUseSession:
      current?.user_id === invitation.target_user_id &&
      current?.authentication_method === "password",
    completed: !!confirmation.receipt,
    ssoFailure:
      failure ??
      (flow?.status === "failed"
        ? "failed"
        : flow?.claims && flow.claims.subject !== invitation.subject
          ? "identity_mismatch"
          : null),
  };
}
