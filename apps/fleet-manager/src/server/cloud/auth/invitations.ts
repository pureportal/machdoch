import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  InvitationInput,
  InvitationOptions,
  InvitationPreview,
} from "../../../lib/cloud-invitation-contract";
import { createSecret, hashSecret, validateSecret } from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, command, recordEvent, requireMembership } from "../access";
import { lockAdministration } from "../administration";
import type { CloudDatabase } from "../database";
import { requireCredentialStorage } from "../credential-storage";
import { createSsoFlow } from "./sso-flow-state";
import {
  checkPendingInvitation,
  invitationLock,
  invitationPreview,
  invitationUnavailable,
  loadInvitationConfirmation,
  readInvitation,
} from "./invitation-state";

function tokenContext(organizationId: string, id: string) {
  return Buffer.from(
    JSON.stringify([
      "cloud.invitation.token",
      organizationId.toLowerCase(),
      id.toLowerCase(),
    ]),
  );
}

export class CloudInvitations {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
  ) {}

  options(actor: CloudActor): Promise<InvitationOptions> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const policy = (
        await sql.query<{ required_sso: boolean }>(
          "SELECT required_sso FROM cloud_signin_policies WHERE organization_id=$1",
          [actor.organizationId],
        )
      ).rows[0];
      const providers = await sql.query<{ id: string; name: string }>(
        "SELECT id,configuration->>'name' AS name FROM cloud_sso_providers WHERE organization_id=$1 AND enabled AND verified_revision=revision ORDER BY configuration->>'name',id",
        [actor.organizationId],
      );
      return {
        requiredSso: policy?.required_sso ?? false,
        credentialStorageAvailable: !!this.cipher,
        providers: providers.rows,
      };
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: InvitationInput,
  ): Promise<{ id: string; token: string }> {
    if (
      input.organizationId.toLowerCase() !== actor.organizationId.toLowerCase()
    )
      return Promise.reject(
        new CloudError(
          409,
          "account_changed",
          "The organization changed. Reload Settings before creating an invitation.",
        ),
      );
    return this.database.transaction(async (sql) => {
      const actorRole = await lockAdministration(sql, actor);
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const result = await command(
        sql,
        actor,
        key,
        { kind: "invitation.create", input },
        async () => {
          if (input.role === "admin" && actorRole !== "owner")
            throw new CloudError(
              403,
              "owner_required",
              "Only an owner can invite administrators.",
            );
          const policy = (
            await sql.query<{ epoch: string; required_sso: boolean }>(
              "SELECT authentication_epoch AS epoch,required_sso FROM cloud_signin_policies WHERE organization_id=$1 FOR SHARE",
              [actor.organizationId],
            )
          ).rows[0];
          if (policy?.required_sso && input.authentication.kind !== "oidc")
            throw new CloudError(
              422,
              "sso_required",
              "Choose an SSO provider for this invitation.",
            );
          await sql.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`user:${input.email}`],
          );
          const user = (
            await sql.query<{
              id: string;
              password_hash: string | null;
              disabled: boolean;
            }>(
              "SELECT id,password_hash,disabled FROM cloud_users WHERE email=$1 FOR SHARE",
              [input.email],
            )
          ).rows[0];
          if (user?.disabled)
            throw new CloudError(
              422,
              "account_unavailable",
              "This account is unavailable.",
            );
          const membership = user
            ? (
                await sql.query<{
                  active: boolean;
                  role: string;
                  epoch: string;
                }>(
                  "SELECT active,role,authentication_epoch AS epoch FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
                  [actor.organizationId, user.id],
                )
              ).rows[0]
            : undefined;
          if (membership?.active)
            throw new CloudError(
              409,
              "already_member",
              "This person is already a member.",
            );
          if (
            membership &&
            ["owner", "admin"].includes(membership.role) &&
            actorRole !== "owner"
          )
            throw new CloudError(
              403,
              "owner_required",
              "Only an owner can restore administrator or owner access.",
            );
          if (
            input.authentication.kind === "password" &&
            user?.password_hash === null
          )
            throw new CloudError(
              422,
              "sso_invitation_required",
              "This account has no password. Choose an SSO provider and subject for the invitation.",
            );
          let providerId: string | null = null,
            providerRevision: number | null = null,
            subject: string | null = null;
          if (input.authentication.kind === "oidc") {
            const mapping = input.authentication;
            const provider = (
              await sql.query<{ id: string; revision: number }>(
                "SELECT id,revision FROM cloud_sso_providers WHERE organization_id=$1 AND id=$2 AND enabled AND verified_revision=revision FOR SHARE",
                [actor.organizationId, input.authentication.providerId],
              )
            ).rows[0];
            if (!provider)
              throw new CloudError(
                422,
                "sso_test_required",
                "Choose an enabled provider with a successful sign-in test.",
              );
            const mappings = await sql.query<{
              user_id: string;
              subject: string;
            }>(
              "SELECT user_id,subject FROM cloud_sso_mappings WHERE organization_id=$1 AND provider_id=$2 AND (subject=$3 OR user_id=$4)",
              [
                actor.organizationId,
                provider.id,
                input.authentication.subject,
                user?.id ?? null,
              ],
            );
            if (
              mappings.rows.some(
                (row) =>
                  row.user_id !== user?.id || row.subject !== mapping.subject,
              )
            )
              throw new CloudError(
                409,
                "sso_mapping_conflict",
                "This identity or account already has a different mapping. Review its identities before inviting it.",
              );
            providerId = provider.id;
            providerRevision = provider.revision;
            subject = input.authentication.subject;
          }
          await sql.query(
            "UPDATE cloud_invitations SET revoked_at=now() WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
            [actor.organizationId, input.email],
          );
          const id = randomUUID(),
            token = createSecret("mch_cloud_invite");
          await sql.query(
            `INSERT INTO cloud_invitations(id,organization_id,email,role,token_hash,invited_by,expires_at,authentication,provider_id,provider_revision,subject,policy_epoch,target_user_id,target_membership_epoch)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '48 hours',$7,$8,$9,$10,$11,$12,$13)`,
            [
              id,
              actor.organizationId,
              input.email,
              input.role,
              hashSecret(token),
              actor.userId,
              input.authentication.kind,
              providerId,
              providerRevision,
              subject,
              policy?.epoch ?? "0",
              user?.id ?? null,
              membership?.epoch ?? null,
            ],
          );
          await recordEvent(sql, actor, "member.invited", id, 1, {
            authentication: input.authentication.kind,
            providerId,
          });
          return {
            id,
            encrypted: cipher
              .encrypt(
                Buffer.from(token),
                tokenContext(actor.organizationId, id),
              )
              .toString("base64url"),
          };
        },
      );
      try {
        await checkPendingInvitation(sql, await readInvitation(sql, result.id));
      } catch (error) {
        if (
          error instanceof CloudError &&
          error.code === "invitation_unavailable"
        )
          throw new CloudError(
            410,
            "invitation_changed",
            "This invitation was already used or changed. Reload Settings before creating another.",
          );
        throw error;
      }
      return {
        id: result.id,
        token: cipher
          .decrypt(
            Buffer.from(result.encrypted, "base64url"),
            tokenContext(actor.organizationId, result.id),
          )
          .toString("utf8"),
      };
    });
  }

  prepare(
    token: string,
    browser: string,
    session: string,
    ssoBrowser: string,
  ): Promise<{ nonce: string; preview: InvitationPreview }> {
    if (!validateSecret(token, "mch_cloud_invite"))
      return Promise.reject(invitationUnavailable());
    return this.database.transaction(async (sql) => {
      const reference = (
        await sql.query<{ id: string; organization_id: string }>(
          "SELECT id,organization_id FROM cloud_invitations WHERE token_hash=$1",
          [hashSecret(token)],
        )
      ).rows[0];
      if (!reference) throw invitationUnavailable();
      await invitationLock(sql, reference.organization_id);
      await requireCredentialStorage(sql, this.cipher);
      const invitation = await readInvitation(sql, reference.id);
      const nonce = validateSecret(browser, "mch_cloud_invitation")
        ? browser
        : createSecret("mch_cloud_invitation");
      await sql.query(
        "DELETE FROM cloud_invitation_confirmations WHERE id IN (SELECT id FROM cloud_invitation_confirmations WHERE expires_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED)",
      );
      if (
        (
          await sql.query(
            "SELECT id FROM cloud_invitation_confirmations WHERE browser_hash=$1",
            [hashSecret(nonce)],
          )
        ).rows.length >= 12
      )
        throw new CloudError(
          429,
          "invitation_limit",
          "Several invitations are already open. Finish one or try again in 15 minutes.",
        );
      const id = randomUUID();
      const confirmation = (
        await sql.query<import("./invitation-state").InvitationConfirmation>(
          "INSERT INTO cloud_invitation_confirmations(id,invitation_id,browser_hash,expires_at) SELECT $1,$2,$3,LEAST(expires_at,now()+interval '15 minutes') FROM cloud_invitations WHERE id=$2 RETURNING *",
          [id, invitation.id, hashSecret(nonce)],
        )
      ).rows[0]!;
      return {
        nonce,
        preview: await invitationPreview(
          sql,
          invitation,
          confirmation,
          session,
          ssoBrowser,
        ),
      };
    });
  }

  inspect(
    id: string,
    browser: string,
    session: string,
    ssoBrowser: string,
  ): Promise<InvitationPreview> {
    return this.database.transaction(async (sql) => {
      const { invitation, confirmation } = await loadInvitationConfirmation(
        sql,
        this.cipher,
        id,
        browser,
      );
      return invitationPreview(
        sql,
        invitation,
        confirmation,
        session,
        ssoBrowser,
      );
    });
  }

  startSso(id: string, browser: string, ssoBrowser: string) {
    return this.database.transaction(async (sql) => {
      const { invitation, confirmation, cipher } =
        await loadInvitationConfirmation(sql, this.cipher, id, browser);
      const { provider } = await checkPendingInvitation(sql, invitation);
      if (!provider || invitation.authentication !== "oidc")
        throw new CloudError(
          422,
          "invitation_method",
          "Use the sign-in method shown in this invitation.",
        );
      if (confirmation.oidc_flow_id)
        await sql.query(
          "UPDATE cloud_sso_flows SET status='failed',proof=NULL,claims=NULL WHERE id=$1 AND status IN ('pending','exchanging','verified')",
          [confirmation.oidc_flow_id],
        );
      const result = await createSsoFlow(
        sql,
        cipher,
        this.origin,
        provider,
        ssoBrowser,
        { mode: "invitation", confirmationId: id },
      );
      await sql.query(
        "UPDATE cloud_invitation_confirmations SET oidc_flow_id=$2 WHERE id=$1",
        [id, result.id],
      );
      return result;
    });
  }
}
