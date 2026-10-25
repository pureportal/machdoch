import { createSecret, hashSecret } from "../crypto";
import { CloudError } from "./access";
import type { CloudSql } from "./database";
import type { CloudSessionContext } from "./auth/session-context";

export async function lockUserSessions(
  sql: CloudSql,
  userIds: string[],
): Promise<void> {
  for (const id of [...new Set(userIds)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `sessions:${id}`,
    ]);
}

export async function issueCloudSession(
  sql: CloudSql,
  userId: string,
  method: "password" | "magic_link" | "oidc",
  organizationId?: string,
  previousToken?: string,
  provider?: { id: string; epoch: string },
  context?: CloudSessionContext,
): Promise<{ sessionToken: string; csrfToken: string }> {
  const membership = (
    await sql.query<{ organization_id: string }>(
      "SELECT organization_id FROM cloud_memberships WHERE user_id=$1 AND active AND ($2::uuid IS NULL OR organization_id=$2) ORDER BY organization_id LIMIT 1 FOR SHARE",
      [userId, organizationId ?? null],
    )
  ).rows[0];
  if (!membership)
    throw new CloudError(
      403,
      "membership_required",
      "This account has no access to the organization.",
    );
  const policy = (
    await sql.query<{ authentication_epoch: string; required_sso: boolean }>(
      "SELECT authentication_epoch,required_sso FROM cloud_signin_policies WHERE organization_id=$1 FOR SHARE",
      [membership.organization_id],
    )
  ).rows[0];
  if (policy?.required_sso && method !== "oidc")
    throw new CloudError(
      403,
      "sso_required",
      "Use your organization's single sign-on provider to sign in.",
    );
  if (
    method === "oidc" &&
    (!provider ||
      !(
        await sql.query(
          "SELECT id FROM cloud_sso_providers WHERE id=$1 AND organization_id=$2 AND enabled AND authentication_epoch=$3 FOR SHARE",
          [provider.id, membership.organization_id, provider.epoch],
        )
      ).rows.length)
  )
    throw new CloudError(
      410,
      "sso_expired",
      "This sign-in provider changed. Start sign-in again.",
    );
  const previous = previousToken
    ? (
        await sql.query<{ user_id: string }>(
          "SELECT user_id FROM cloud_sessions WHERE token_hash=$1",
          [hashSecret(previousToken)],
        )
      ).rows[0]
    : undefined;
  await lockUserSessions(sql, [
    userId,
    ...(previous ? [previous.user_id] : []),
  ]);
  await sql.query(
    "DELETE FROM cloud_sessions s WHERE user_id=$1 AND organization_id=$2 AND NOT cloud_session_active(s)",
    [userId, membership.organization_id],
  );
  await sql.query(
    "DELETE FROM cloud_sessions WHERE token_hash IN (SELECT token_hash FROM cloud_sessions WHERE user_id=$1 AND organization_id=$2 ORDER BY created_at DESC,token_hash OFFSET 7)",
    [userId, membership.organization_id],
  );
  if (previousToken)
    await sql.query("DELETE FROM cloud_sessions WHERE token_hash=$1", [
      hashSecret(previousToken),
    ]);
  const sessionToken = createSecret("mch_cloud_session"),
    csrfToken = createSecret("mch_cloud_csrf");
  await sql.query(
    "INSERT INTO cloud_sessions (token_hash,csrf_hash,user_id,organization_id,expires_at,authentication_epoch,membership_epoch,authentication_method,policy_epoch,provider_id,provider_epoch,browser,platform,address) SELECT $1,$2,u.id,m.organization_id,now()+interval '12 hours',u.authentication_epoch,m.authentication_epoch,$5,$6,$7,$8,$9,$10,$11 FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id WHERE u.id=$3 AND m.organization_id=$4 AND m.active AND NOT u.disabled",
    [
      hashSecret(sessionToken),
      hashSecret(csrfToken),
      userId,
      membership.organization_id,
      method,
      policy?.authentication_epoch ?? "0",
      provider?.id ?? null,
      provider?.epoch ?? null,
      context?.browser ?? null,
      context?.platform ?? null,
      context?.address ?? null,
    ],
  );
  return { sessionToken, csrfToken };
}
