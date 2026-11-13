import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  GitAccount,
  GitAccountInput,
  GitAccounts,
} from "../../../lib/cloud-git-contract";
import {
  gitProviderLabels,
  type GitProvider,
} from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import {
  checkRevision,
  CloudError,
  recordEvent,
  requireMembership,
} from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { gitClient } from "./git-client";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function accountContext(
  provider: GitProvider,
  organizationId: string,
  userId: string,
  apiUrl: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: `cloud.${provider}.account`,
      organizationId,
      userId,
      apiUrl,
    }),
  );
}

export interface StoredTokens {
  token: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export function encryptAccountSecret(
  cipher: SettingsCipher,
  account: {
    provider: GitProvider;
    organizationId: string;
    userId: string;
    apiUrl: string;
  },
  value: string,
  purpose: "token" | "refresh",
): Buffer {
  const context = accountContext(
    account.provider,
    account.organizationId,
    account.userId,
    account.apiUrl,
  );
  return cipher.encrypt(
    Buffer.from(value),
    purpose === "token"
      ? context
      : Buffer.concat([context, Buffer.from("/refresh")]),
  );
}

export function decryptAccountSecret(
  cipher: SettingsCipher,
  account: {
    provider: GitProvider;
    organizationId: string;
    userId: string;
    apiUrl: string;
  },
  value: Uint8Array,
  purpose: "token" | "refresh",
): string {
  const context = accountContext(
    account.provider,
    account.organizationId,
    account.userId,
    account.apiUrl,
  );
  try {
    return cipher
      .decrypt(
        Buffer.from(value),
        purpose === "token"
          ? context
          : Buffer.concat([context, Buffer.from("/refresh")]),
      )
      .toString("utf8");
  } catch {
    throw new CloudError(
      503,
      "credential_storage",
      `Your ${gitProviderLabels[account.provider]} sign-in cannot be unlocked. Connect your account again.`,
    );
  }
}

export async function saveAccount(
  sql: CloudSql,
  cipher: SettingsCipher,
  actor: CloudActor,
  account: {
    provider: GitProvider;
    apiUrl: string;
    login: string;
    revision: number | null;
  } & StoredTokens,
): Promise<{ revision: number }> {
  const identity = { ...account, ...actor };
  const current = (
    await sql.query<{ revision: number }>(
      "SELECT revision FROM cloud_git_accounts WHERE organization_id=$1 AND user_id=$2 AND provider=$3 FOR UPDATE",
      [actor.organizationId, actor.userId, account.provider],
    )
  ).rows[0];
  if (account.revision !== null)
    checkRevision(current?.revision ?? 0, account.revision);
  const taken = await sql.query(
    "SELECT 1 FROM cloud_git_accounts WHERE organization_id=$1 AND provider=$2 AND api_url=$3 AND lower(login)=lower($4) AND user_id<>$5",
    [
      actor.organizationId,
      account.provider,
      account.apiUrl,
      account.login,
      actor.userId,
    ],
  );
  if (taken.rows.length)
    throw new CloudError(
      409,
      "git_account_taken",
      `${account.login} is already connected by another member.`,
    );
  const updated = (
    await sql.query<{ revision: number }>(
      `INSERT INTO cloud_git_accounts (organization_id,user_id,provider,api_url,secret,token_prefix,login,refresh_secret,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (organization_id,user_id,provider) DO UPDATE SET api_url=$4,secret=$5,token_prefix=$6,login=$7,refresh_secret=$8,expires_at=$9,
      revision=cloud_git_accounts.revision+1,connected_at=clock_timestamp(),last_error=NULL
      RETURNING revision`,
      [
        actor.organizationId,
        actor.userId,
        account.provider,
        account.apiUrl,
        encryptAccountSecret(cipher, identity, account.token, "token"),
        account.token.slice(0, 12),
        account.login.slice(0, 100),
        account.refreshToken
          ? encryptAccountSecret(
              cipher,
              identity,
              account.refreshToken,
              "refresh",
            )
          : null,
        account.expiresAt,
      ],
    )
  ).rows[0]!;
  await recordEvent(
    sql,
    actor,
    "git.account_connected",
    actor.userId,
    updated.revision,
    { provider: account.provider, login: account.login },
  );
  return updated;
}

export async function usersForLogins(
  sql: CloudSql,
  organizationId: string,
  provider: GitProvider,
  apiUrl: string,
  logins: readonly string[],
): Promise<Map<string, string>> {
  if (!logins.length) return new Map();
  const rows = (
    await sql.query<{ login: string; user_id: string }>(
      `SELECT lower(a.login) AS login,a.user_id FROM cloud_git_accounts a
      JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=a.user_id AND m.active
      WHERE a.organization_id=$1 AND a.provider=$2 AND a.api_url=$3 AND lower(a.login)=ANY($4::text[])`,
      [
        organizationId,
        provider,
        apiUrl,
        logins.map((login) => login.toLowerCase()),
      ],
    )
  ).rows;
  return new Map(rows.map((row) => [row.login, row.user_id]));
}

export class CloudGitAccounts {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch,
  ) {}

  get(actor: CloudActor): Promise<GitAccounts> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const accounts = (
        await sql.query<GitAccount & Record<string, unknown>>(
          `SELECT provider,api_url AS "apiUrl",login,token_prefix AS "tokenPrefix",revision,
          to_char(connected_at AT TIME ZONE 'UTC',${timestamp}) AS "connectedAt",
          to_char(last_used_at AT TIME ZONE 'UTC',${timestamp}) AS "lastUsedAt",last_error AS "lastError"
          FROM cloud_git_accounts WHERE organization_id=$1 AND user_id=$2`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
      const connections = (
        await sql.query<{
          provider: GitProvider;
          apiUrl: string;
          oauth: boolean;
        }>(
          `SELECT provider,api_url AS "apiUrl",oauth_client_id IS NOT NULL AS oauth FROM cloud_git_connections WHERE organization_id=$1`,
          [actor.organizationId],
        )
      ).rows;
      return {
        accounts: Object.fromEntries(
          accounts.map((account) => [account.provider, account]),
        ),
        connections: Object.fromEntries(
          connections.map((connection) => [
            connection.provider,
            { apiUrl: connection.apiUrl, oauth: connection.oauth },
          ]),
        ),
        credentialStorageAvailable: this.cipher !== null,
      };
    });
  }

  async connect(
    actor: CloudActor,
    provider: GitProvider,
    input: GitAccountInput,
  ): Promise<{ revision: number }> {
    if (actor.delegation)
      throw new CloudError(
        403,
        "git_account_browser",
        "Connect your account in the browser.",
      );
    await this.database.transaction((sql) => requireMembership(sql, actor));
    const login = await gitClient(
      { provider, apiUrl: input.apiUrl, token: input.token },
      this.transport,
    ).viewer();
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return saveAccount(
        sql,
        await requireCredentialStorage(sql, this.cipher),
        actor,
        {
          provider,
          apiUrl: input.apiUrl,
          login,
          revision: input.revision,
          token: input.token,
          refreshToken: null,
          expiresAt: null,
        },
      );
    });
  }

  disconnect(
    actor: CloudActor,
    provider: GitProvider,
    revision: number,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const current = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_git_accounts WHERE organization_id=$1 AND user_id=$2 AND provider=$3 FOR UPDATE",
          [actor.organizationId, actor.userId, provider],
        )
      ).rows[0];
      if (!current) return;
      checkRevision(current.revision, revision);
      await sql.query(
        "DELETE FROM cloud_git_accounts WHERE organization_id=$1 AND user_id=$2 AND provider=$3",
        [actor.organizationId, actor.userId, provider],
      );
      await recordEvent(
        sql,
        actor,
        "git.account_disconnected",
        actor.userId,
        revision,
        { provider },
      );
    });
  }
}
