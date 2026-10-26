import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import {
  hashOwnerPasswordAsync,
  hashSecret,
  validateSecret,
  verifyOwnerPassword,
  verifySecret,
} from "../crypto";
import { CloudError } from "./access";
import type { CloudDatabase } from "./database";
import { issueCloudSession, lockUserSessions } from "./session-issuance";
import type { CloudSessionContext } from "./auth/session-context";

export const cloudSessionCookie = "__Host-machdoch_cloud_session";
export const cloudCsrfCookie = "__Host-machdoch_cloud_csrf";
export const cloudCsrfHeader = "x-machdoch-cloud-csrf";
const dummyHash =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class CloudIdentity {
  constructor(private readonly database: CloudDatabase) {}

  async bootstrap(input: {
    organization: string;
    email: string;
    name: string;
    password: string;
    origin?: string;
  }): Promise<CloudActor> {
    const passwordHash = await hashOwnerPasswordAsync(input.password);
    return this.database.transaction(async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(1940327612)");
      if (
        (await sql.query("SELECT id FROM cloud_organizations LIMIT 1")).rows
          .length
      )
        throw new CloudError(
          409,
          "already_initialized",
          "Cloud is already initialized.",
        );
      const userId = randomUUID();
      const organizationId = randomUUID();
      await sql.query(
        "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
        [userId, input.email, input.name, passwordHash],
      );
      await sql.query(
        "INSERT INTO cloud_organizations (id,name) VALUES ($1,$2)",
        [organizationId, input.organization],
      );
      await sql.query(
        "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
        [organizationId, userId],
      );
      await sql.query(
        "UPDATE cloud_installation SET organization_id=$1,origin=COALESCE($2,origin) WHERE id=1",
        [organizationId, input.origin ?? null],
      );
      return { organizationId, userId };
    });
  }

  async limitLogin(address: string, email: string): Promise<void> {
    return this.limitAttempts("credentials", address, email, [20, 8, 100]);
  }

  async limitMagicProof(address: string, identity: string): Promise<void> {
    return this.limitAttempts("magic-proof", address, identity, [120, 12, 600]);
  }

  private async limitAttempts(
    bucket: string,
    address: string,
    identity: string,
    limits: readonly [number, number, number],
  ): Promise<void> {
    const allowed = await this.database.transaction(async (sql) => {
      await sql.query(
        "DELETE FROM cloud_login_limits WHERE expires_at < now() - interval '1 hour'",
      );
      for (const [key, limit] of [
        [`${bucket}:global`, limits[2]],
        [`${bucket}:address:${address}`, limits[0]],
        [`${bucket}:identity:${identity}`, limits[1]],
      ] as const) {
        const row = (
          await sql.query<{ attempts: number }>(
            `INSERT INTO cloud_login_limits (key,attempts,expires_at) VALUES ($1,1,now()+interval '1 minute')
          ON CONFLICT (key) DO UPDATE SET attempts=CASE WHEN cloud_login_limits.expires_at<=now() THEN 1 ELSE cloud_login_limits.attempts+1 END,
          expires_at=CASE WHEN cloud_login_limits.expires_at<=now() THEN now()+interval '1 minute' ELSE cloud_login_limits.expires_at END RETURNING attempts`,
            [hashSecret(key)],
          )
        ).rows[0]!;
        if (row.attempts > limit) return false;
      }
      return true;
    });
    if (!allowed)
      throw new CloudError(
        429,
        "rate_limited",
        "Too many sign-in attempts. Try again in a minute.",
      );
  }

  async login(
    email: string,
    password: string,
    organizationId?: string,
    previousToken?: string,
    context?: CloudSessionContext,
  ): Promise<{ sessionToken: string; csrfToken: string }> {
    const user = await this.database.transaction(
      async (sql) =>
        (
          await sql.query<{ id: string; password_hash: string | null }>(
            "SELECT id,password_hash FROM cloud_users WHERE lower(coalesce(login_name,email))=lower($1) AND NOT disabled",
            [email],
          )
        ).rows[0],
    );
    const passwordValid = await verifyOwnerPassword(
      password,
      user?.password_hash ?? dummyHash,
    );
    if (!user || !passwordValid)
      throw new CloudError(
        401,
        "invalid_credentials",
        "Login or password is incorrect.",
      );
    return this.database.transaction(async (sql) => {
      const current = await sql.query(
        "SELECT id FROM cloud_users WHERE id=$1 AND password_hash=$2 AND NOT disabled FOR SHARE",
        [user.id, user.password_hash],
      );
      if (!current.rows.length)
        throw new CloudError(
          401,
          "invalid_credentials",
          "Login or password is incorrect.",
        );
      return issueCloudSession(
        sql,
        user.id,
        "password",
        organizationId,
        previousToken,
        undefined,
        context,
      );
    });
  }

  authenticate(token: string, csrf?: string): Promise<CloudActor | null> {
    if (!validateSecret(token, "mch_cloud_session"))
      return Promise.resolve(null);
    return this.database.transaction(async (sql) => {
      const row = (
        await sql.query<{
          userId: string;
          organizationId: string;
          csrf_hash: string;
        }>(
          `SELECT s.user_id AS "userId",s.organization_id AS "organizationId",s.csrf_hash FROM cloud_sessions s
        WHERE s.token_hash=$1 AND cloud_session_active(s) FOR UPDATE OF s`,
          [hashSecret(token)],
        )
      ).rows[0];
      if (!row) return null;
      if (
        csrf !== undefined &&
        (!validateSecret(csrf, "mch_cloud_csrf") ||
          !verifySecret(csrf, row.csrf_hash))
      )
        throw new CloudError(
          403,
          "invalid_csrf",
          "Your request token expired. Reload the page and try again.",
        );
      await sql.query(
        "UPDATE cloud_sessions SET touched_at=now() WHERE token_hash=$1",
        [hashSecret(token)],
      );
      return { userId: row.userId, organizationId: row.organizationId };
    });
  }

  async logout(
    token: string,
    confirmationNonce?: string,
    ssoBrowser?: string,
    invitationBrowser?: string,
  ): Promise<void> {
    const validToken = validateSecret(token, "mch_cloud_session");
    const validNonce =
      confirmationNonce &&
      validateSecret(confirmationNonce, "mch_cloud_confirmation");
    const validSso = ssoBrowser && validateSecret(ssoBrowser, "mch_cloud_sso");
    const validInvitation =
      invitationBrowser &&
      validateSecret(invitationBrowser, "mch_cloud_invitation");
    if (!validToken && !validNonce && !validSso && !validInvitation) return;
    await this.database.transaction(async (sql) => {
      const hashes = validToken ? [hashSecret(token)] : [];
      if (validInvitation) {
        const confirmations = await sql.query<{ session_hash: string | null }>(
          "DELETE FROM cloud_invitation_confirmations WHERE id IN (SELECT id FROM cloud_invitation_confirmations WHERE browser_hash=$1 ORDER BY id FOR UPDATE) RETURNING session_hash",
          [hashSecret(invitationBrowser!)],
        );
        hashes.push(
          ...confirmations.rows.flatMap((row) =>
            row.session_hash ? [row.session_hash] : [],
          ),
        );
      }
      if (validSso) {
        const flows = await sql.query<{ session_hash: string | null }>(
          "DELETE FROM cloud_sso_flows WHERE id IN (SELECT id FROM cloud_sso_flows WHERE browser_hash=$1 ORDER BY id FOR UPDATE) RETURNING session_hash",
          [hashSecret(ssoBrowser!)],
        );
        hashes.push(
          ...flows.rows.flatMap((row) =>
            row.session_hash ? [row.session_hash] : [],
          ),
        );
      }
      if (validNonce) {
        const removed = await sql.query<{ session_hash: string | null }>(
          "DELETE FROM cloud_magic_confirmations WHERE id IN (SELECT id FROM cloud_magic_confirmations WHERE nonce_hash=$1 ORDER BY id FOR UPDATE) RETURNING session_hash",
          [hashSecret(confirmationNonce!)],
        );
        hashes.push(
          ...removed.rows.flatMap((row) =>
            row.session_hash ? [row.session_hash] : [],
          ),
        );
      }
      if (!hashes.length) return;
      const owners = await sql.query<{ user_id: string }>(
        "SELECT DISTINCT user_id FROM cloud_sessions WHERE token_hash=ANY($1::text[])",
        [hashes],
      );
      await lockUserSessions(
        sql,
        owners.rows.map((row) => row.user_id),
      );
      await sql.query(
        "DELETE FROM cloud_sessions WHERE token_hash=ANY($1::text[])",
        [hashes],
      );
    });
  }
}
