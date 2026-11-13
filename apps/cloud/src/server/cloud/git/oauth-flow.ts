import { createHash, randomBytes } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  gitProviderLabels,
  type GitProvider,
} from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, requireMembership } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase } from "../database";
import { saveAccount } from "./accounts";
import { gitConnection } from "./connections";
import { gitClient } from "./git-client";
import { exchangeOAuthCode, oauthAuthorizeUrl } from "./oauth";

const stateLifetimeMinutes = 10;

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export class CloudGitOAuth {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch,
    private readonly callbackUrl: (provider: GitProvider) => string,
  ) {}

  start(actor: CloudActor, provider: GitProvider): Promise<{ url: string }> {
    if (actor.delegation)
      throw new CloudError(
        403,
        "git_account_browser",
        "Connect your account in the browser.",
      );
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const connection = await gitConnection(
        sql,
        this.cipher,
        actor.organizationId,
        provider,
      );
      if (!connection.oauth)
        throw new CloudError(
          409,
          "git_oauth_unconfigured",
          `Sign-in with ${gitProviderLabels[provider]} is not set up. Connect a token instead.`,
        );
      await sql.query(
        `DELETE FROM cloud_git_oauth_states WHERE created_at < clock_timestamp() - interval '${stateLifetimeMinutes} minutes'`,
      );
      const state = randomBytes(32).toString("base64url");
      await sql.query(
        "INSERT INTO cloud_git_oauth_states (state_hash,organization_id,user_id,provider) VALUES ($1,$2,$3,$4)",
        [stateHash(state), actor.organizationId, actor.userId, provider],
      );
      return {
        url: oauthAuthorizeUrl(
          provider,
          connection.apiUrl,
          connection.oauth.clientId,
          this.callbackUrl(provider),
          state,
        ),
      };
    });
  }

  async complete(
    provider: GitProvider,
    code: string,
    state: string,
  ): Promise<void> {
    const pending = await this.database.transaction(async (sql) => {
      const claimed = (
        await sql.query<{ organization_id: string; user_id: string }>(
          `DELETE FROM cloud_git_oauth_states WHERE state_hash=$1 AND provider=$2
          AND created_at > clock_timestamp() - interval '${stateLifetimeMinutes} minutes' RETURNING organization_id,user_id`,
          [stateHash(state), provider],
        )
      ).rows[0];
      if (!claimed)
        throw new CloudError(
          400,
          "git_oauth_state",
          "This sign-in expired. Start again.",
        );
      return {
        actor: {
          organizationId: claimed.organization_id,
          userId: claimed.user_id,
        },
        connection: await gitConnection(
          sql,
          this.cipher,
          claimed.organization_id,
          provider,
        ),
      };
    });
    const { actor, connection } = pending;
    if (!connection.oauth)
      throw new CloudError(
        409,
        "git_oauth_unconfigured",
        `Sign-in with ${gitProviderLabels[provider]} is not set up.`,
      );
    const tokens = await exchangeOAuthCode(
      provider,
      connection.apiUrl,
      connection.oauth,
      this.callbackUrl(provider),
      code,
      this.transport,
    );
    const login = await gitClient(
      { provider, apiUrl: connection.apiUrl, token: tokens.accessToken },
      this.transport,
    ).viewer();
    await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      await saveAccount(
        sql,
        await requireCredentialStorage(sql, this.cipher),
        actor,
        {
          provider,
          apiUrl: connection.apiUrl,
          login,
          revision: null,
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      );
    });
  }
}
