import { createHash } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { CloudOAuthScope } from "../../../lib/cloud-oauth-contract";
import { createSecret, hashSecret } from "../../crypto";
import { isCloudError, requireMembership } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { OAuthError, type TokenInput } from "./validation";

interface Grant extends Record<string, unknown> {
  id: string;
  organizationId: string;
  userId: string;
  scopes: CloudOAuthScope[];
  expiresAt: Date;
}
export class CloudOAuthTokens {
  constructor(
    private readonly database: CloudDatabase,
    private readonly origin: string,
  ) {}

  async exchange(input: TokenInput) {
    if (input.resource !== `${this.origin}/api/v1/mcp`)
      throw new OAuthError(
        "invalid_target",
        "The requested resource is unavailable.",
      );
    const isCode = input.grant_type === "authorization_code";
    const hash = hashSecret(isCode ? input.code : input.refresh_token);
    const table = isCode ? "cloud_oauth_codes" : "cloud_oauth_tokens";
    const result = await this.database.transaction(async (sql) => {
      const found = (
        await sql.query<Grant>(
          `SELECT g.id,g.organization_id AS "organizationId",g.user_id AS "userId",g.scopes,g.expires_at AS "expiresAt"
         FROM ${table} t JOIN cloud_oauth_grants g ON g.id=t.grant_id
         WHERE t.hash=$1 AND g.client_id=$2 AND g.resource=$3 ${isCode ? "" : "AND t.kind='refresh'"}`,
          [hash, input.client_id, input.resource],
        )
      ).rows[0];
      if (!found) return null;
      try {
        await requireMembership(sql, found);
      } catch (error) {
        if (isCloudError(error)) return null;
        throw error;
      }
      const grant = (
        await sql.query<Grant>(
          `SELECT id,scopes,expires_at AS "expiresAt" FROM cloud_oauth_grants WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()
          AND authentication_epoch=(SELECT authentication_epoch FROM cloud_users WHERE id=cloud_oauth_grants.user_id)
          AND membership_epoch=(SELECT authentication_epoch FROM cloud_memberships WHERE organization_id=cloud_oauth_grants.organization_id AND user_id=cloud_oauth_grants.user_id)
          AND cloud_login_authority_valid(organization_id,authentication_method,policy_epoch,provider_id,provider_epoch) FOR UPDATE`,
          [found.id],
        )
      ).rows[0];
      if (!grant) return null;
      const token = (
        await sql.query<{
          consumed_at: Date | null;
          challenge?: string;
          redirect_uri?: string;
        }>(
          `SELECT * FROM ${table} WHERE hash=$1 AND expires_at>clock_timestamp() FOR UPDATE`,
          [hash],
        )
      ).rows[0];
      if (!token) return null;
      if (
        isCode &&
        (token.redirect_uri !== input.redirect_uri ||
          token.challenge !==
            createHash("sha256")
              .update(input.code_verifier)
              .digest("base64url"))
      )
        return null;
      if (
        !isCode &&
        input.scope !== undefined &&
        input.scope !== grant.scopes.join(" ")
      )
        return { error: "invalid_scope" } as const;
      if (token.consumed_at) {
        await sql.query(
          "UPDATE cloud_oauth_grants SET revoked_at=now() WHERE id=$1",
          [grant.id],
        );
        return null;
      }
      await sql.query(`UPDATE ${table} SET consumed_at=now() WHERE hash=$1`, [
        hash,
      ]);
      return issueTokens(sql, grant);
    });
    if (!result)
      throw new OAuthError(
        "invalid_grant",
        "Authorization expired or was already used. Reconnect from the app.",
      );
    if ("error" in result)
      throw new OAuthError(
        result.error,
        "Refresh scope must match the granted scope.",
      );
    return result;
  }

  async authenticate(
    token: string,
  ): Promise<{ actor: CloudActor; scopes: CloudOAuthScope[] } | null> {
    if (!token || token.length > 200) return null;
    const hash = hashSecret(token);
    return this.database.transaction(async (sql) => {
      const row = (
        await sql.query<Grant>(
          `SELECT g.id,g.organization_id AS "organizationId",g.user_id AS "userId",g.scopes FROM cloud_oauth_tokens t
         JOIN cloud_oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>clock_timestamp()
         AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.resource=$2`,
          [hash, `${this.origin}/api/v1/mcp`],
        )
      ).rows[0];
      if (!row) return null;
      const actor: CloudActor = {
        organizationId: row.organizationId,
        userId: row.userId,
        delegation: { tokenHash: hash, scope: "cloud:read" },
      };
      try {
        await requireMembership(sql, actor);
      } catch (error) {
        if (isCloudError(error)) return null;
        throw error;
      }
      return { actor, scopes: row.scopes };
    });
  }

  async revoke(clientId: string, token: string): Promise<void> {
    await this.database.transaction(async (sql) => {
      await sql.query(
        `UPDATE cloud_oauth_grants SET revoked_at=now() WHERE client_id=$1 AND id IN
        (SELECT grant_id FROM cloud_oauth_tokens WHERE hash=$2)`,
        [clientId, hashSecret(token)],
      );
    });
  }
}

async function issueTokens(sql: CloudSql, grant: Grant) {
  const access = createSecret("mca");
  const refresh = createSecret("mcr");
  const expiry = (
    await sql.query<{ seconds: number }>(
      `SELECT greatest(0,floor(extract(epoch FROM least($1::timestamptz,clock_timestamp()+interval '1 hour')-clock_timestamp())))::integer AS seconds`,
      [grant.expiresAt],
    )
  ).rows[0]!.seconds;
  if (expiry < 1) return null;
  await sql.query(
    `INSERT INTO cloud_oauth_tokens (hash,grant_id,kind,expires_at) VALUES
    ($1,$3,'access',clock_timestamp()+make_interval(secs=>$4)),($2,$3,'refresh',$5)`,
    [
      hashSecret(access),
      hashSecret(refresh),
      grant.id,
      expiry,
      grant.expiresAt,
    ],
  );
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: expiry,
    scope: grant.scopes.join(" "),
  };
}
