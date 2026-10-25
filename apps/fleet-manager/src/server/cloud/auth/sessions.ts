import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudSessionInfo,
  SessionAccount,
  SessionRevocation,
  SessionRevocationResult,
} from "../../../lib/cloud-session-contract";
import { hashSecret } from "../../crypto";
import { CloudError, command, recordEvent, requireMembership } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { lockUserSessions } from "../session-issuance";

async function requireAccountSession(
  sql: CloudSql,
  actor: CloudActor,
  tokenHash: string,
): Promise<{ id: string }> {
  if (actor.delegation)
    throw new CloudError(
      403,
      "browser_required",
      "Open Account in your browser to manage sessions.",
    );
  const row = (
    await sql.query<{ id: string }>(
      "SELECT id FROM cloud_sessions s WHERE token_hash=$1 AND organization_id=$2 AND user_id=$3 AND cloud_session_active(s)",
      [tokenHash, actor.organizationId, actor.userId],
    )
  ).rows[0];
  if (!row)
    throw new CloudError(
      401,
      "authentication_required",
      "Sign in again to manage your sessions.",
    );
  return row;
}

export class CloudSessions {
  constructor(private readonly database: CloudDatabase) {}

  async list(
    actor: CloudActor,
    token: string,
    account: SessionAccount,
  ): Promise<CloudSessionInfo[]> {
    requireSameAccount(actor, account);
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const current = await requireAccountSession(
        sql,
        actor,
        hashSecret(token),
      );
      return (
        await sql.query<CloudSessionInfo & Record<string, unknown>>(
          `SELECT s.id,s.id=$3 AS current,s.browser,s.platform,s.address,s.authentication_method AS method,p.configuration->>'name' AS provider,
        to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(s.touched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastActiveAt",
        to_char(LEAST(s.expires_at,s.touched_at+interval '30 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
        FROM cloud_sessions s LEFT JOIN cloud_sso_providers p ON p.id=s.provider_id
        WHERE s.organization_id=$1 AND s.user_id=$2 AND cloud_session_active(s) ORDER BY (s.id=$3) DESC,s.touched_at DESC,s.id`,
          [actor.organizationId, actor.userId, current.id],
        )
      ).rows;
    });
  }

  async revoke(
    actor: CloudActor,
    key: string,
    token: string,
    input: SessionRevocation,
  ): Promise<SessionRevocationResult> {
    requireSameAccount(actor, input.account);
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      await lockUserSessions(sql, [actor.userId]);
      const current = await requireAccountSession(
        sql,
        actor,
        hashSecret(token),
      );
      return command(
        sql,
        actor,
        key,
        { kind: "sessions.revoke", input, currentId: current.id },
        async () => {
          const removed = await sql.query<{ id: string }>(
            "DELETE FROM cloud_sessions WHERE organization_id=$1 AND user_id=$2 AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND id<>$4)) RETURNING id",
            [
              actor.organizationId,
              actor.userId,
              input.scope === "session" ? input.id : null,
              current.id,
            ],
          );
          if (removed.rows.length)
            await recordEvent(sql, actor, "sessions.revoked", actor.userId, 1, {
              sessionIds: removed.rows.map((row) => row.id),
              scope: input.scope,
            });
          return {
            signedOut: removed.rows.some((row) => row.id === current.id),
            revoked: removed.rows.length,
          };
        },
      );
    });
  }
}

function requireSameAccount(actor: CloudActor, account: SessionAccount): void {
  if (
    actor.organizationId.toLowerCase() !==
      account.organizationId.toLowerCase() ||
    actor.userId.toLowerCase() !== account.userId.toLowerCase()
  )
    throw new CloudError(
      409,
      "account_changed",
      "The signed-in account or organization changed. Reload Account to continue.",
    );
}
