import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CredentialsInput,
  CredentialStatus,
} from "../../../lib/cloud-credentials-contract";
import {
  hashOwnerPasswordAsync,
  hashSecret,
  verifyOwnerPassword,
} from "../../crypto";
import { CloudError, recordEvent, requireMembership } from "../access";
import type { CloudDatabase } from "../database";

export class CloudCredentials {
  constructor(private readonly database: CloudDatabase) {}

  status(actor: CloudActor): Promise<CredentialStatus> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CredentialStatus & Record<string, unknown>>(
          'SELECT login_name AS username,password_hash IS NOT NULL AS "passwordEnabled" FROM cloud_users WHERE id=$1',
          [actor.userId],
        )
      ).rows[0]!;
    });
  }

  async change(
    actor: CloudActor,
    token: string,
    input: CredentialsInput,
  ): Promise<void> {
    if (
      input.account.userId !== actor.userId ||
      input.account.organizationId !== actor.organizationId
    )
      throw new CloudError(
        409,
        "account_changed",
        "Your account changed. Reload the page before saving.",
      );
    const current = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<{
          password_hash: string | null;
          login_name: string | null;
        }>("SELECT password_hash,login_name FROM cloud_users WHERE id=$1", [
          actor.userId,
        ])
      ).rows[0]!;
    });
    if (!current.password_hash)
      throw new CloudError(
        403,
        "password_unavailable",
        "Manage your password through your sign-in provider.",
      );
    if (
      !(await verifyOwnerPassword(input.currentPassword, current.password_hash))
    )
      throw new CloudError(
        422,
        "incorrect_password",
        "Current password is incorrect.",
      );
    if (input.username !== undefined && current.login_name === null)
      throw new CloudError(
        422,
        "invalid_username",
        "This account uses email to sign in.",
      );
    const username = input.username ?? current.login_name;
    const passwordHash = await hashOwnerPasswordAsync(input.newPassword);
    try {
      await this.database.transaction(async (sql) => {
        const changed = await sql.query(
          `UPDATE cloud_users u SET password_hash=$1,login_name=$2
          WHERE u.id=$3 AND u.password_hash=$4 AND NOT u.disabled
          AND EXISTS (SELECT 1 FROM cloud_sessions s WHERE s.token_hash=$5 AND s.user_id=u.id AND s.organization_id=$6 AND cloud_session_active(s)) RETURNING u.id`,
          [
            passwordHash,
            username,
            actor.userId,
            current.password_hash,
            hashSecret(token),
            actor.organizationId,
          ],
        );
        if (!changed.rows.length)
          throw new CloudError(
            409,
            "account_changed",
            "Your sign-in details changed. Sign in again.",
          );
        await recordEvent(
          sql,
          actor,
          "account.credentials_changed",
          actor.userId,
          1,
          { usernameChanged: username !== current.login_name },
        );
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      )
        throw new CloudError(
          409,
          "username_unavailable",
          "This username is already in use.",
        );
      throw error;
    }
  }
}
