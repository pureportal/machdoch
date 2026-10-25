import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudConsent,
  CloudConnectedApp,
  CloudOAuthScope,
} from "../../../lib/cloud-oauth-contract";
import { createSecret, hashSecret } from "../../crypto";
import { CloudError, recordEvent, requireMembership } from "../access";
import type { CloudDatabase } from "../database";
import {
  authorizeSchema,
  nativeCloudClient,
  OAuthError,
  singleParameters,
} from "./validation";

type AuthorizationRequest = Record<string, unknown> & {
  id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  challenge: string;
  state: string;
  scopes: CloudOAuthScope[];
  organization_id: string | null;
  user_id: string | null;
};

export class CloudAuthorization {
  constructor(
    private readonly database: CloudDatabase,
    private readonly origin: string,
  ) {}

  async begin(parameters: URLSearchParams): Promise<string> {
    const input = authorizeSchema.safeParse(singleParameters(parameters));
    if (!input.success)
      throw new OAuthError(
        "invalid_request",
        "The authorization request is invalid. Reconnect from the app.",
      );
    if (input.data.resource !== `${this.origin}/api/v1/mcp`)
      throw new OAuthError(
        "invalid_target",
        "The requested resource is unavailable.",
      );
    const id = randomUUID();
    await this.database.transaction(async (sql) => {
      await sql.query(
        "DELETE FROM cloud_oauth_requests WHERE expires_at < now()",
      );
      await sql.query(
        `INSERT INTO cloud_oauth_requests (id,client_id,redirect_uri,resource,challenge,state,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          input.data.client_id,
          input.data.redirect_uri,
          input.data.resource,
          input.data.code_challenge,
          input.data.state,
          input.data.scope,
        ],
      );
    });
    return id;
  }

  async consent(actor: CloudActor, id: string): Promise<CloudConsent> {
    return this.database.transaction(async (sql) => {
      const role = await requireMembership(sql, actor);
      const request = (
        await sql.query<AuthorizationRequest>(
          `UPDATE cloud_oauth_requests SET organization_id=$2,user_id=$3 WHERE id=$1 AND decided_at IS NULL
         AND expires_at>clock_timestamp() AND (user_id IS NULL OR (user_id=$3 AND organization_id=$2)) RETURNING *`,
          [id, actor.organizationId, actor.userId],
        )
      ).rows[0];
      if (!request)
        throw new CloudError(
          410,
          "authorization_expired",
          "This connection request expired. Reconnect from the app.",
        );
      const details = (
        await sql.query<{ organization: string; account: string }>(
          `SELECT o.name AS organization,u.email AS account FROM cloud_organizations o,cloud_users u WHERE o.id=$1 AND u.id=$2`,
          [actor.organizationId, actor.userId],
        )
      ).rows[0]!;
      return {
        id,
        clientName: nativeCloudClient.name,
        ...details,
        redirectUri: request.redirect_uri,
        scopes: request.scopes.filter(
          (scope) => role !== "viewer" || scope === "cloud:read",
        ),
      };
    });
  }

  async decide(
    actor: CloudActor,
    id: string,
    approve: boolean,
    scopes: CloudOAuthScope[],
    sessionToken: string,
  ): Promise<string> {
    return this.database.transaction(async (sql) => {
      const role = await requireMembership(sql, actor);
      const request = (
        await sql.query<AuthorizationRequest>(
          `SELECT * FROM cloud_oauth_requests WHERE id=$1 AND organization_id=$2 AND user_id=$3
         AND decided_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
          [id, actor.organizationId, actor.userId],
        )
      ).rows[0];
      if (!request)
        throw new CloudError(
          410,
          "authorization_expired",
          "This connection request expired. Reconnect from the app.",
        );
      if (
        approve &&
        (!scopes.includes("cloud:read") ||
          new Set(scopes).size !== scopes.length ||
          scopes.some(
            (scope) =>
              !request.scopes.includes(scope) ||
              (role === "viewer" && scope !== "cloud:read"),
          ))
      )
        throw new CloudError(
          422,
          "invalid_scope",
          "Choose only the access shown for this connection.",
        );
      await sql.query(
        "UPDATE cloud_oauth_requests SET decided_at=now() WHERE id=$1",
        [id],
      );
      const redirect = new URL(request.redirect_uri);
      redirect.searchParams.set("state", request.state);
      redirect.searchParams.set("iss", this.origin);
      if (!approve) {
        redirect.searchParams.set("error", "access_denied");
        return redirect.href;
      }
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `oauth:${actor.organizationId}:${actor.userId}`,
      ]);
      const count = (
        await sql.query<{ total: number }>(
          `SELECT count(*)::integer AS total FROM cloud_oauth_grants WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()
           AND authentication_epoch=(SELECT authentication_epoch FROM cloud_users WHERE id=$2)
           AND membership_epoch=(SELECT authentication_epoch FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2) AND cloud_login_authority_valid(organization_id,authentication_method,policy_epoch,provider_id,provider_epoch)`,
          [actor.organizationId, actor.userId],
        )
      ).rows[0]!.total;
      if (count >= 20)
        throw new CloudError(
          409,
          "connection_limit",
          "Disconnect an app before adding another connection.",
        );
      const grantId = randomUUID();
      const code = createSecret("mcc");
      const issued = await sql.query(
        `INSERT INTO cloud_oauth_grants (id,client_id,organization_id,user_id,resource,scopes,authentication_epoch,membership_epoch,authentication_method,policy_epoch,provider_id,provider_epoch)
         SELECT $1,$2,$3,$4,$5,$6,s.authentication_epoch,s.membership_epoch,s.authentication_method,s.policy_epoch,s.provider_id,s.provider_epoch FROM cloud_sessions s
         WHERE s.token_hash=$7 AND s.user_id=$4 AND s.organization_id=$3 AND cloud_session_active(s) RETURNING id`,
        [
          grantId,
          request.client_id,
          actor.organizationId,
          actor.userId,
          request.resource,
          scopes,
          hashSecret(sessionToken),
        ],
      );
      if (!issued.rows.length)
        throw new CloudError(
          401,
          "authentication_required",
          "Sign in again before connecting this app.",
        );
      await sql.query(
        "INSERT INTO cloud_oauth_codes (hash,grant_id,redirect_uri,challenge) VALUES ($1,$2,$3,$4)",
        [hashSecret(code), grantId, request.redirect_uri, request.challenge],
      );
      await recordEvent(sql, actor, "oauth.connected", grantId, 1, {
        clientId: request.client_id,
        scopes,
      });
      redirect.searchParams.set("code", code);
      return redirect.href;
    });
  }

  async connections(actor: CloudActor): Promise<CloudConnectedApp[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const rows = (
        await sql.query<{
          id: string;
          scopes: CloudOAuthScope[];
          createdAt: Date;
          expiresAt: Date;
        }>(
          `SELECT id,scopes,created_at AS "createdAt",expires_at AS "expiresAt" FROM cloud_oauth_grants
         WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()
         AND authentication_epoch=(SELECT authentication_epoch FROM cloud_users WHERE id=$2)
         AND membership_epoch=(SELECT authentication_epoch FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2) AND cloud_login_authority_valid(organization_id,authentication_method,policy_epoch,provider_id,provider_epoch) ORDER BY created_at DESC LIMIT 100`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
      return rows.map((row) => ({
        ...row,
        clientName: nativeCloudClient.name,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }));
    });
  }

  async disconnect(actor: CloudActor, id: string): Promise<void> {
    await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const rows = (
        await sql.query(
          `UPDATE cloud_oauth_grants SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL RETURNING id`,
          [id, actor.organizationId, actor.userId],
        )
      ).rows;
      if (rows.length)
        await recordEvent(sql, actor, "oauth.disconnected", id, 1, {});
    });
  }
}
