import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { ClientSignInConsent } from "../../../lib/client-sign-in-contract";
import { createSecret } from "../../crypto";
import { nowSeconds } from "../../database";
import { getRuntime } from "../../runtime";
import { CloudError, requireMembership } from "../access";
import type { CloudDatabase } from "../database";
import { OAuthError, singleParameters } from "./validation";

export const clientSignInId = "machdoch-desktop";

const signInSchema = z.object({
  redirect_uri: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})\/callback$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((name) => !/[\p{Cc}\p{Cf}]/u.test(name)),
});

interface SignInRequest extends Record<string, unknown> {
  redirect_uri: string;
  challenge: string;
  state: string;
  client_name: string;
}

const expired = () =>
  new CloudError(
    410,
    "authorization_expired",
    "This sign-in expired. Sign in again from the app.",
  );

export class CloudClientSignIn {
  constructor(
    private readonly database: CloudDatabase,
    private readonly origin: string,
  ) {}

  async begin(parameters: URLSearchParams): Promise<string> {
    const input = signInSchema.safeParse(singleParameters(parameters));
    if (!input.success)
      throw new OAuthError(
        "invalid_request",
        "The sign-in request is invalid. Sign in again from the app.",
      );
    const id = randomUUID();
    await this.database.transaction(async (sql) => {
      await sql.query(
        "DELETE FROM cloud_oauth_requests WHERE expires_at < now()",
      );
      await sql.query(
        `INSERT INTO cloud_oauth_requests (id,client_id,redirect_uri,resource,challenge,state,scopes,client_name) VALUES ($1,$2,$3,$4,$5,$6,'{}',$7)`,
        [
          id,
          clientSignInId,
          input.data.redirect_uri,
          `${this.origin}/api/enroll`,
          input.data.code_challenge,
          input.data.state,
          input.data.name,
        ],
      );
    });
    return id;
  }

  async consent(
    actor: CloudActor,
    id: string,
  ): Promise<ClientSignInConsent | null> {
    return this.database.transaction(async (sql) => {
      const kind = (
        await sql.query<{ client_id: string }>(
          "SELECT client_id FROM cloud_oauth_requests WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (kind?.client_id !== clientSignInId) return null;
      const access = await requireMembership(sql, actor);
      const request = (
        await sql.query<SignInRequest>(
          `UPDATE cloud_oauth_requests SET organization_id=$2,user_id=$3 WHERE id=$1 AND client_id=$4 AND decided_at IS NULL
           AND expires_at>clock_timestamp() AND (user_id IS NULL OR (user_id=$3 AND organization_id=$2)) RETURNING *`,
          [id, actor.organizationId, actor.userId, clientSignInId],
        )
      ).rows[0];
      if (!request) throw expired();
      const details = (
        await sql.query<{ organization: string; account: string }>(
          `SELECT o.name AS organization,u.email AS account FROM cloud_organizations o,cloud_users u WHERE o.id=$1 AND u.id=$2`,
          [actor.organizationId, actor.userId],
        )
      ).rows[0]!;
      return {
        id,
        clientName: request.client_name,
        ...details,
        canShare: access.owner || access.permissions.has("clients.manage"),
      };
    });
  }

  async decide(
    actor: CloudActor,
    id: string,
    approve: boolean,
    shared: boolean,
  ): Promise<string> {
    const request = await this.database.transaction(async (sql) => {
      await requireMembership(
        sql,
        actor,
        approve && shared ? "clients.manage" : undefined,
      );
      const found = (
        await sql.query<SignInRequest>(
          `UPDATE cloud_oauth_requests SET decided_at=now() WHERE id=$1 AND client_id=$2 AND organization_id=$3 AND user_id=$4
           AND decided_at IS NULL AND expires_at>clock_timestamp() RETURNING *`,
          [id, clientSignInId, actor.organizationId, actor.userId],
        )
      ).rows[0];
      if (!found) throw expired();
      return found;
    });
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("state", request.state);
    if (!approve) {
      redirect.searchParams.set("error", "access_denied");
      return redirect.href;
    }
    const code = createSecret("mch_enroll");
    await getRuntime().fleetStore.createSignInGrant(
      code,
      request.challenge,
      shared ? null : actor.userId,
      nowSeconds(),
    );
    redirect.searchParams.set("code", code);
    return redirect.href;
  }
}
