import type { CloudActor } from "../../../lib/cloud-contract";
import type { SettingsCipher } from "../../settings-crypto";
import { hashSecret } from "../../crypto";
import { CloudError, recordEvent, requireMembership } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { issueCloudSession, lockUserSessions } from "../session-issuance";
import type { CloudSessionContext } from "./session-context";
import { insertSsoMapping, type SsoProviderRow } from "./sso-providers";

import {
  createSsoFlow,
  flowByBrowser,
  flowContext,
  providerForFlow,
  ssoUnavailable as unavailable,
  type SsoFlow,
} from "./sso-flow-state";

export interface SsoPreview {
  id: string;
  mode: "login" | "link";
  provider: string;
  identity: string;
  account: string;
  currentAccount: string | null;
}

export class CloudSsoFlows {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
  ) {}

  available() {
    return this.database.transaction(
      async (sql) =>
        (
          await sql.query<{ id: string; name: string; organization: string }>(
            "SELECT p.id,p.configuration->>'name' AS name,o.name AS organization FROM cloud_sso_providers p JOIN cloud_organizations o ON o.id=p.organization_id WHERE p.enabled ORDER BY o.name,p.configuration->>'name',p.id LIMIT 100",
          )
        ).rows,
    );
  }

  begin(
    providerId: string,
    mode: "login" | "link",
    browser: string,
    session: string,
    actor?: CloudActor,
    authorizationId?: string,
  ) {
    return this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const provider = (
        await sql.query<SsoProviderRow>(
          "SELECT * FROM cloud_sso_providers WHERE id=$1 AND enabled FOR SHARE",
          [providerId],
        )
      ).rows[0];
      if (!provider) throw unavailable();
      if (mode === "link") {
        if (!actor || actor.organizationId !== provider.organization_id)
          throw unavailable();
        await requireMembership(sql, actor);
        const fresh = await sql.query(
          "SELECT token_hash FROM cloud_sessions s WHERE token_hash=$1 AND user_id=$2 AND organization_id=$3 AND created_at>clock_timestamp()-interval '5 minutes' AND cloud_session_active(s)",
          [hashSecret(session), actor.userId, actor.organizationId],
        );
        if (!fresh.rows.length)
          throw new CloudError(
            403,
            "sso_fresh_login",
            "Sign in again before linking an identity.",
          );
      }
      if (
        authorizationId &&
        !(
          await sql.query(
            "SELECT id FROM cloud_oauth_requests WHERE id=$1 AND decided_at IS NULL AND expires_at>clock_timestamp()",
            [authorizationId],
          )
        ).rows.length
      )
        throw new CloudError(
          410,
          "authorization_expired",
          "Reconnect from the app to start a new sign-in.",
        );
      return createSsoFlow(
        sql,
        cipher,
        this.origin,
        provider,
        browser,
        mode === "link"
          ? { mode, userId: actor!.userId, sessionToken: session }
          : { mode, authorizationId },
      );
    });
  }

  preview(id: string, browser: string, session: string): Promise<SsoPreview> {
    return this.database.transaction(async (sql) => {
      const flow = await flowByBrowser(sql, id, browser);
      if (flow.mode === "invitation") throw unavailable();
      const provider = await providerForFlow(sql, flow);
      const userId = await this.resolveUser(sql, flow, session);
      const membership = (
        await sql.query<{ authentication_epoch: string }>(
          "SELECT authentication_epoch FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
          [flow.organization_id, userId],
        )
      ).rows[0]!;
      if (
        flow.status !== "completed" &&
        flow.resolved_user_id &&
        (flow.resolved_user_id !== userId ||
          flow.resolved_membership_epoch !== membership.authentication_epoch)
      )
        throw unavailable();
      if (!flow.resolved_user_id)
        await sql.query(
          "UPDATE cloud_sso_flows SET resolved_user_id=$2,resolved_membership_epoch=$3 WHERE id=$1",
          [id, userId, membership.authentication_epoch],
        );
      const account = (
        await sql.query<{ email: string }>(
          "SELECT email FROM cloud_users WHERE id=$1",
          [userId],
        )
      ).rows[0]!.email;
      const current = (
        await sql.query<{ email: string }>(
          "SELECT u.email FROM cloud_sessions s JOIN cloud_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND cloud_session_active(s)",
          [hashSecret(session)],
        )
      ).rows[0];
      return {
        id,
        mode: flow.mode,
        provider: provider.configuration.name,
        identity: flow.claims!.display,
        account,
        currentAccount: current?.email ?? null,
      };
    });
  }

  consume(
    id: string,
    browser: string,
    previousToken: string,
    context?: CloudSessionContext,
  ) {
    return this.database.transaction(async (sql) => {
      const reference = (
        await sql.query<{ organization_id: string }>(
          "SELECT organization_id FROM cloud_sso_flows WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!reference) throw unavailable();
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `administration:${reference.organization_id}`,
      ]);
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const flow = await flowByBrowser(sql, id, browser);
      if (flow.mode === "invitation") throw unavailable();
      const provider = await providerForFlow(sql, flow);
      const redirect = flow.authorization_id
        ? `/cloud/authorize?requestId=${flow.authorization_id}`
        : flow.mode === "link"
          ? "/cloud/account"
          : "/cloud/issues";
      if (flow.receipt) {
        const users = await sql.query<{ user_id: string }>(
          "SELECT DISTINCT user_id FROM cloud_sessions WHERE token_hash=ANY($1::text[])",
          [[flow.session_hash, hashSecret(previousToken)]],
        );
        await lockUserSessions(
          sql,
          users.rows.map((row) => row.user_id),
        );
        const alive = await sql.query(
          "SELECT 1 FROM cloud_sessions s WHERE s.token_hash=$1 AND cloud_session_active(s) FOR SHARE OF s",
          [flow.session_hash],
        );
        if (!alive.rows.length) throw unavailable();
        const receipt = JSON.parse(
          cipher
            .decrypt(
              Buffer.from(flow.receipt),
              flowContext(id, flow.browser_hash, "receipt"),
            )
            .toString("utf8"),
        ) as { sessionToken: string; csrfToken: string };
        if (hashSecret(receipt.sessionToken) !== flow.session_hash)
          throw unavailable();
        if (previousToken && hashSecret(previousToken) !== flow.session_hash)
          await sql.query("DELETE FROM cloud_sessions WHERE token_hash=$1", [
            hashSecret(previousToken),
          ]);
        return { ...receipt, redirect };
      }
      const userId = await this.resolveUser(sql, flow, previousToken);
      const membership = (
        await sql.query<{ authentication_epoch: string }>(
          "SELECT authentication_epoch FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
          [flow.organization_id, userId],
        )
      ).rows[0]!;
      if (
        flow.resolved_user_id !== userId ||
        flow.resolved_membership_epoch !== membership.authentication_epoch
      )
        throw unavailable();
      const actor = { organizationId: flow.organization_id, userId };
      if (flow.mode === "link")
        await insertSsoMapping(
          sql,
          actor,
          flow.provider_id,
          userId,
          flow.claims!.subject,
        );
      const previous = (
        await sql.query<{ user_id: string }>(
          "SELECT user_id FROM cloud_sessions WHERE token_hash=$1",
          [hashSecret(previousToken)],
        )
      ).rows[0];
      await lockUserSessions(sql, [
        userId,
        ...(previous ? [previous.user_id] : []),
      ]);
      if (
        flow.mode === "link" &&
        !(
          await sql.query(
            `SELECT 1 FROM cloud_sessions s JOIN cloud_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.user_id=$2 AND s.organization_id=$3 AND s.expires_at>clock_timestamp() AND s.touched_at>clock_timestamp()-interval '30 minutes'
        AND s.authentication_epoch=u.authentication_epoch AND s.membership_epoch=$4 AND cloud_login_authority_valid(s.organization_id,s.authentication_method,s.policy_epoch,s.provider_id,s.provider_epoch)`,
            [
              flow.bound_session_hash,
              userId,
              flow.organization_id,
              flow.resolved_membership_epoch,
            ],
          )
        ).rows.length
      )
        throw unavailable();
      const credentials = await issueCloudSession(
        sql,
        userId,
        "oidc",
        flow.organization_id,
        previousToken,
        { id: provider.id, epoch: provider.authentication_epoch },
        context,
      );
      await sql.query(
        "UPDATE cloud_sso_flows SET status='completed',receipt=$2,session_hash=$3,expires_at=LEAST(expires_at,clock_timestamp()+interval '5 minutes') WHERE id=$1",
        [
          id,
          cipher.encrypt(
            Buffer.from(JSON.stringify(credentials)),
            flowContext(id, flow.browser_hash, "receipt"),
          ),
          hashSecret(credentials.sessionToken),
        ],
      );
      await sql.query(
        "UPDATE cloud_sso_providers SET verified_revision=revision WHERE id=$1 AND revision=$2",
        [provider.id, provider.revision],
      );
      await recordEvent(sql, actor, "session.oidc", userId, 1, {
        providerId: provider.id,
      });
      return { ...credentials, redirect };
    });
  }

  private async resolveUser(
    sql: CloudSql,
    flow: SsoFlow,
    session: string,
  ): Promise<string> {
    if (!flow.claims || !["verified", "completed"].includes(flow.status))
      throw unavailable();
    let userId: string | undefined;
    if (flow.mode === "link" && flow.status !== "completed") {
      if (flow.bound_session_hash !== hashSecret(session))
        throw new CloudError(
          403,
          "sso_link_session",
          "Sign in with the account that started this link, then try again.",
        );
      const valid = await sql.query(
        `SELECT 1 FROM cloud_sessions s JOIN cloud_users u ON u.id=s.user_id JOIN cloud_memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id
        WHERE s.token_hash=$1 AND s.user_id=$2 AND s.organization_id=$3 AND cloud_session_active(s) FOR SHARE OF u,m`,
        [flow.bound_session_hash, flow.user_id, flow.organization_id],
      );
      if (!valid.rows.length) throw unavailable();
      userId = flow.user_id!;
      const mapped = await sql.query(
        "SELECT user_id FROM cloud_sso_mappings WHERE organization_id=$1 AND provider_id=$2 AND (subject=$3 OR user_id=$4)",
        [flow.organization_id, flow.provider_id, flow.claims.subject, userId],
      );
      if (mapped.rows.length)
        throw new CloudError(
          409,
          "sso_already_linked",
          "This identity or account is already linked. Ask an administrator to review the mapping.",
        );
    } else {
      userId = (
        await sql.query<{ user_id: string }>(
          "SELECT user_id FROM cloud_sso_mappings WHERE organization_id=$1 AND provider_id=$2 AND subject=$3",
          [flow.organization_id, flow.provider_id, flow.claims.subject],
        )
      ).rows[0]?.user_id;
    }
    if (!userId)
      throw new CloudError(
        403,
        "sso_unmapped",
        "This identity is not linked to an account. Sign in with your existing account to link it, or contact an administrator.",
      );
    await requireMembership(sql, {
      organizationId: flow.organization_id,
      userId,
    });
    if (
      flow.status !== "completed" &&
      !(
        await sql.query(
          "SELECT 1 FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.organization_id=$2 AND GREATEST(u.authentication_epoch,m.authentication_epoch)<=$3",
          [userId, flow.organization_id, flow.generation],
        )
      ).rows.length
    )
      throw unavailable();
    return userId;
  }
}
