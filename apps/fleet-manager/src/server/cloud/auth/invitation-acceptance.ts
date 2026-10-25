import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InvitationAccept } from "../../../lib/cloud-invitation-contract";
import {
  hashOwnerPasswordAsync,
  hashSecret,
  verifyOwnerPassword,
} from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, recordEvent } from "../access";
import type { CloudDatabase } from "../database";
import { issueCloudSession, lockUserSessions } from "../session-issuance";
import type { CloudSessionContext } from "./session-context";
import { insertSsoMapping } from "./sso-providers";
import {
  checkPendingInvitation,
  currentInvitationSession,
  invitationIdentity,
  invitationReceiptContext,
  invitationUnavailable,
  loadInvitationConfirmation,
} from "./invitation-state";

const credentialsSchema = z.strictObject({
  sessionToken: z.string().max(200),
  csrfToken: z.string().max(200),
});
const accountChanged = () =>
  new CloudError(
    409,
    "account_changed",
    "The signed-in account changed. Review this invitation again before joining.",
  );

export class CloudInvitationAcceptance {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
  ) {}

  async accept(
    input: InvitationAccept,
    browser: string,
    session: string,
    ssoBrowser: string,
    context?: CloudSessionContext,
  ): Promise<{ sessionToken: string; csrfToken: string; redirect: string }> {
    const snapshot = await this.database.transaction(async (sql) => {
      const { invitation, confirmation } = await loadInvitationConfirmation(
        sql,
        this.cipher,
        input.confirmationId,
        browser,
      );
      if (confirmation.receipt) return { kind: "receipt" } as const;
      const { user } = await checkPendingInvitation(sql, invitation);
      const current = await currentInvitationSession(sql, session);
      if ((current?.id ?? null) !== input.sessionId) throw accountChanged();
      if (!user && !input.name)
        throw new CloudError(422, "name_required", "Enter your name to join.");
      if (invitation.authentication === "oidc")
        return { kind: "oidc" } as const;
      if (
        user &&
        current?.user_id === user.id &&
        current.authentication_method === "password"
      )
        return { kind: "session", userId: user.id } as const;
      if (!input.password)
        throw new CloudError(
          422,
          "password_required",
          user
            ? "Enter your account password to join."
            : "Choose a password to join.",
        );
      if (user && !user.password_hash)
        throw new CloudError(
          422,
          "sso_invitation_required",
          "Ask for an SSO invitation for this account.",
        );
      return user
        ? ({
            kind: "password",
            userId: user.id,
            passwordHash: user.password_hash!,
          } as const)
        : ({ kind: "new" } as const);
    });
    if (
      snapshot.kind === "password" &&
      !(await verifyOwnerPassword(input.password!, snapshot.passwordHash))
    )
      throw new CloudError(
        401,
        "invalid_credentials",
        "The password is incorrect. Enter this account's password.",
      );
    const newPasswordHash =
      snapshot.kind === "new"
        ? await hashOwnerPasswordAsync(input.password!)
        : null;
    return this.database.transaction(async (sql) => {
      const { invitation, confirmation, cipher } =
        await loadInvitationConfirmation(
          sql,
          this.cipher,
          input.confirmationId,
          browser,
        );
      const previous = await currentInvitationSession(sql, session);
      if (confirmation.receipt) {
        const owners = await sql.query<{ user_id: string }>(
          "SELECT DISTINCT user_id FROM cloud_sessions WHERE token_hash=ANY($1::text[])",
          [[confirmation.session_hash, hashSecret(session)]],
        );
        await lockUserSessions(
          sql,
          owners.rows.map((row) => row.user_id),
        );
        const current = await currentInvitationSession(sql, session);
        const restored = (
          await sql.query<{ id: string }>(
            "SELECT id FROM cloud_sessions s WHERE token_hash=$1 AND cloud_session_active(s) FOR SHARE",
            [confirmation.session_hash],
          )
        ).rows[0];
        if (!restored) throw invitationUnavailable();
        if (
          current?.id !== restored.id &&
          (current?.id ?? null) !== input.sessionId &&
          !(
            current === null &&
            input.sessionId === confirmation.confirmed_session_id
          )
        )
          throw accountChanged();
        const credentials = credentialsSchema.parse(
          JSON.parse(
            cipher
              .decrypt(
                Buffer.from(confirmation.receipt),
                invitationReceiptContext(
                  confirmation.id,
                  confirmation.browser_hash,
                ),
              )
              .toString("utf8"),
          ),
        );
        if (hashSecret(credentials.sessionToken) !== confirmation.session_hash)
          throw invitationUnavailable();
        if (session && hashSecret(session) !== confirmation.session_hash)
          await sql.query("DELETE FROM cloud_sessions WHERE token_hash=$1", [
            hashSecret(session),
          ]);
        return { ...credentials, redirect: "/cloud/issues" };
      }
      const { user, provider } = await checkPendingInvitation(sql, invitation);
      if ((previous?.id ?? null) !== input.sessionId) throw accountChanged();
      if (snapshot.kind === "receipt") throw invitationUnavailable();
      if (invitation.authentication === "oidc") {
        const identity = await invitationIdentity(
          sql,
          invitation,
          confirmation,
          ssoBrowser,
        );
        if (!identity || identity.status !== "verified")
          throw new CloudError(
            422,
            "sso_required",
            "Sign in through the invitation's provider before joining.",
          );
        if (identity.claims?.subject !== invitation.subject)
          throw new CloudError(
            403,
            "identity_mismatch",
            "This identity does not match the invitation. Sign in with the invited identity.",
          );
      } else if (snapshot.kind === "session") {
        if (
          user?.id !== snapshot.userId ||
          previous?.user_id !== user.id ||
          previous.authentication_method !== "password"
        )
          throw accountChanged();
      } else if (snapshot.kind === "password") {
        if (
          user?.id !== snapshot.userId ||
          user.password_hash !== snapshot.passwordHash
        )
          throw invitationUnavailable();
      } else if (snapshot.kind !== "new" || user || !newPasswordHash)
        throw invitationUnavailable();
      const userId = user?.id ?? randomUUID();
      if (!user) {
        if (!input.name)
          throw new CloudError(
            422,
            "name_required",
            "Enter your name to join.",
          );
        await sql.query(
          "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
          [
            userId,
            invitation.email,
            input.name,
            invitation.authentication === "password" ? newPasswordHash : null,
          ],
        );
      }
      if (invitation.target_membership_epoch === null)
        await sql.query(
          "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
          [invitation.organization_id, userId, invitation.role],
        );
      else {
        const updated = await sql.query(
          "UPDATE cloud_memberships SET role=$3,active=true,revision=revision+1 WHERE organization_id=$1 AND user_id=$2 AND NOT active AND authentication_epoch=$4 RETURNING user_id",
          [
            invitation.organization_id,
            userId,
            invitation.role,
            invitation.target_membership_epoch,
          ],
        );
        if (!updated.rows.length) throw invitationUnavailable();
      }
      const actor = { organizationId: invitation.organization_id, userId };
      if (
        provider &&
        !(
          await sql.query(
            "SELECT user_id FROM cloud_sso_mappings WHERE organization_id=$1 AND provider_id=$2 AND user_id=$3 AND subject=$4",
            [actor.organizationId, provider.id, userId, invitation.subject],
          )
        ).rows.length
      )
        await insertSsoMapping(
          sql,
          actor,
          provider.id,
          userId,
          invitation.subject!,
        );
      await sql.query(
        "DELETE FROM cloud_invitation_confirmations WHERE invitation_id=$1 AND id<>$2",
        [invitation.id, confirmation.id],
      );
      await lockUserSessions(sql, [
        userId,
        ...(previous ? [previous.user_id] : []),
      ]);
      const current = await currentInvitationSession(sql, session);
      if ((current?.id ?? null) !== input.sessionId) throw accountChanged();
      if (
        snapshot.kind === "session" &&
        (current?.user_id !== userId ||
          current.authentication_method !== "password")
      )
        throw accountChanged();
      const accepted = await sql.query(
        "UPDATE cloud_invitations SET accepted_at=clock_timestamp(),accepted_by=$2 WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM cloud_invitation_confirmations WHERE id=$3 AND expires_at>clock_timestamp()) RETURNING id",
        [invitation.id, userId, confirmation.id],
      );
      if (!accepted.rows.length) throw invitationUnavailable();
      const credentials = await issueCloudSession(
        sql,
        userId,
        provider ? "oidc" : "password",
        actor.organizationId,
        session,
        provider
          ? { id: provider.id, epoch: provider.authentication_epoch }
          : undefined,
        context,
      );
      await sql.query(
        "UPDATE cloud_invitation_confirmations SET receipt=$2,session_hash=$3,confirmed_session_id=$4,completed_at=clock_timestamp(),expires_at=LEAST(expires_at,clock_timestamp()+interval '5 minutes') WHERE id=$1",
        [
          confirmation.id,
          cipher.encrypt(
            Buffer.from(JSON.stringify(credentials)),
            invitationReceiptContext(
              confirmation.id,
              confirmation.browser_hash,
            ),
          ),
          hashSecret(credentials.sessionToken),
          input.sessionId,
        ],
      );
      await recordEvent(sql, actor, "member.joined", userId, 1, {
        invitationId: invitation.id,
        invitedBy: invitation.invited_by,
        authentication: invitation.authentication,
      });
      return { ...credentials, redirect: "/cloud/issues" };
    });
  }
}
