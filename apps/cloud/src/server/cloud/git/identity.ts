import {
  gitProviderLabels,
  type GitProvider,
} from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, isCloudError } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { decryptAccountSecret, encryptAccountSecret } from "./accounts";
import type { GitAccess } from "./git-client";
import { gitConnection, type GitConnectionRecord } from "./connections";
import { refreshOAuthToken, type OAuthTokens } from "./oauth";

export interface ActingAccess extends GitAccess {
  login: string;
  personal: boolean;
}

const refreshMarginMs = 60_000;

interface PendingRefresh {
  connection: GitConnectionRecord & {
    oauth: NonNullable<GitConnectionRecord["oauth"]>;
  };
  refreshToken: string;
  expiresAt: Date;
}

export function organizationAccess(
  connection: GitConnectionRecord,
): ActingAccess {
  return {
    provider: connection.provider,
    apiUrl: connection.apiUrl,
    token: connection.token,
    login: connection.app ? `${connection.app.slug}[bot]` : connection.account,
    personal: false,
  };
}

export function accountRequired(provider: GitProvider): CloudError {
  const label = gitProviderLabels[provider];
  return new CloudError(
    409,
    "git_account_required",
    `Link your ${label} account under Settings → Linked accounts so this runs as you on ${label}.`,
  );
}

export class GitIdentities {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch,
    private readonly callbackUrl: (provider: GitProvider) => string,
  ) {}

  private refreshable(
    organizationId: string,
    userId: string,
  ): Promise<PendingRefresh[]> {
    return this.database.transaction(async (sql) => {
      const expiring = (
        await sql.query<{
          oauth_connection_id: string;
          api_url: string;
          refresh_secret: Uint8Array;
          expires_at: Date;
        }>(
          `SELECT oauth_connection_id,api_url,refresh_secret,expires_at FROM cloud_git_accounts
          WHERE organization_id=$1 AND user_id=$2 AND refresh_secret IS NOT NULL AND oauth_connection_id IS NOT NULL
          AND expires_at < clock_timestamp() + $3 * interval '1 millisecond'`,
          [organizationId, userId, refreshMarginMs],
        )
      ).rows;
      if (!expiring.length) return [];
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const pending: PendingRefresh[] = [];
      for (const account of expiring) {
        const connection = await gitConnection(
          sql,
          this.cipher,
          organizationId,
          account.oauth_connection_id,
        );
        const oauth = connection.oauth;
        if (!oauth || connection.apiUrl !== account.api_url) continue;
        pending.push({
          connection: { ...connection, oauth },
          expiresAt: account.expires_at,
          refreshToken: decryptAccountSecret(
            cipher,
            { ...connection, userId },
            account.refresh_secret,
            "refresh",
          ),
        });
      }
      return pending;
    });
  }

  async refreshExpiring(organizationId: string, userId: string): Promise<void> {
    for (const pending of await this.refreshable(organizationId, userId)) {
      const { connection } = pending;
      let tokens: OAuthTokens;
      try {
        tokens = await refreshOAuthToken(
          connection.provider,
          connection.apiUrl,
          connection.oauth,
          this.callbackUrl(connection.provider),
          pending.refreshToken,
          this.transport,
        );
      } catch (error) {
        if (!isCloudError(error)) throw error;
        continue;
      }
      await this.database.transaction(async (sql) => {
        const cipher = await requireCredentialStorage(sql, this.cipher);
        const account = { ...connection, userId };
        await sql.query(
          `UPDATE cloud_git_accounts SET secret=$4,token_prefix=$5,refresh_secret=COALESCE($6,refresh_secret),expires_at=$7,last_error=NULL
          WHERE organization_id=$1 AND user_id=$2 AND provider=$3 AND expires_at=$8`,
          [
            organizationId,
            userId,
            connection.provider,
            encryptAccountSecret(cipher, account, tokens.accessToken, "token"),
            tokens.accessToken.slice(0, 12),
            tokens.refreshToken
              ? encryptAccountSecret(
                  cipher,
                  account,
                  tokens.refreshToken,
                  "refresh",
                )
              : null,
            tokens.expiresAt,
            pending.expiresAt,
          ],
        );
      });
    }
  }

  async personal(
    sql: CloudSql,
    connection: GitConnectionRecord,
    userId: string,
  ): Promise<ActingAccess | null> {
    const stored = (
      await sql.query<{
        secret: Uint8Array;
        expires_at: Date | null;
        login: string;
      }>(
        "SELECT secret,expires_at,login FROM cloud_git_accounts WHERE organization_id=$1 AND user_id=$2 AND provider=$3 AND api_url=$4",
        [
          connection.organizationId,
          userId,
          connection.provider,
          connection.apiUrl,
        ],
      )
    ).rows[0];
    if (!stored) return null;
    if (stored.expires_at && stored.expires_at.getTime() <= Date.now())
      return null;
    const cipher = await requireCredentialStorage(sql, this.cipher);
    await sql.query(
      "UPDATE cloud_git_accounts SET last_used_at=clock_timestamp() WHERE organization_id=$1 AND user_id=$2 AND provider=$3",
      [connection.organizationId, userId, connection.provider],
    );
    return {
      provider: connection.provider,
      apiUrl: connection.apiUrl,
      token: decryptAccountSecret(
        cipher,
        { ...connection, userId },
        stored.secret,
        "token",
      ),
      login: stored.login,
      personal: true,
    };
  }

  async actingLogin(
    sql: CloudSql,
    connection: GitConnectionRecord,
    userId: string,
  ): Promise<string | null> {
    return (
      (
        await sql.query<{ login: string }>(
          "SELECT login FROM cloud_git_accounts WHERE organization_id=$1 AND user_id=$2 AND provider=$3 AND api_url=$4",
          [
            connection.organizationId,
            userId,
            connection.provider,
            connection.apiUrl,
          ],
        )
      ).rows[0]?.login ?? null
    );
  }

  async acting(
    sql: CloudSql,
    connection: GitConnectionRecord,
    userId: string,
  ): Promise<ActingAccess> {
    const personal = await this.personal(sql, connection, userId);
    if (!personal) throw accountRequired(connection.provider);
    return personal;
  }

  async rejected(
    connection: GitConnectionRecord,
    userId: string,
  ): Promise<CloudError> {
    const label = gitProviderLabels[connection.provider];
    const message = `${label} rejected your sign-in. Sign in again under Settings → Linked accounts.`;
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_git_accounts SET last_error=$4 WHERE organization_id=$1 AND user_id=$2 AND provider=$3",
        [connection.organizationId, userId, connection.provider, message],
      ),
    );
    return new CloudError(409, "git_account_required", message);
  }
}
