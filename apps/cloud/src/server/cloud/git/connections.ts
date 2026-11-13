import { randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  GitAdministration,
  GitAvailableRepository,
  GitConnection,
  GitConnectionInput,
  GitRepository,
  GitRepositoryOption,
} from "../../../lib/cloud-git-contract";
import {
  gitProviderLabels,
  gitProviders,
  type GitProvider,
} from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import {
  checkRevision,
  CloudError,
  command,
  isCloudError,
  recordEvent,
  requireMembership,
} from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { readStatusRules } from "./automations";
import { gitClient, type GitAccess } from "./git-client";
import type { OAuthApp } from "./oauth";

export const currentHookVersion = 2;

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function tokenContext(
  provider: GitProvider,
  organizationId: string,
  apiUrl: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({ kind: `cloud.${provider}.token`, organizationId, apiUrl }),
  );
}

function webhookContext(
  provider: GitProvider,
  organizationId: string,
  webhookId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: `cloud.${provider}.webhook`,
      organizationId,
      webhookId,
    }),
  );
}

function oauthContext(
  provider: GitProvider,
  organizationId: string,
  clientId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: `cloud.${provider}.oauth`,
      organizationId,
      clientId,
    }),
  );
}

export interface GitConnectionRecord extends GitAccess {
  organizationId: string;
  account: string;
  oauth: OAuthApp | null;
  webhookId: string;
  webhookSecret: string;
  actorId: string;
  automate: boolean;
}

type StoredConnection = {
  organization_id: string;
  provider: GitProvider;
  api_url: string;
  account: string;
  secret: Uint8Array;
  webhook_id: string;
  webhook_secret: Uint8Array;
  actor_id: string;
  automate: boolean;
  oauth_client_id: string | null;
  oauth_secret: Uint8Array | null;
};

function unconfigured(provider: GitProvider): CloudError {
  return new CloudError(
    409,
    "git_unconfigured",
    `Connect ${gitProviderLabels[provider]} first.`,
  );
}

function unlock(
  cipher: SettingsCipher,
  row: StoredConnection,
): GitConnectionRecord {
  try {
    return {
      organizationId: row.organization_id,
      provider: row.provider,
      apiUrl: row.api_url,
      account: row.account,
      token: cipher
        .decrypt(
          Buffer.from(row.secret),
          tokenContext(row.provider, row.organization_id, row.api_url),
        )
        .toString("utf8"),
      webhookId: row.webhook_id,
      webhookSecret: cipher
        .decrypt(
          Buffer.from(row.webhook_secret),
          webhookContext(row.provider, row.organization_id, row.webhook_id),
        )
        .toString("utf8"),
      actorId: row.actor_id,
      automate: row.automate,
      oauth:
        row.oauth_client_id && row.oauth_secret
          ? {
              clientId: row.oauth_client_id,
              clientSecret: cipher
                .decrypt(
                  Buffer.from(row.oauth_secret),
                  oauthContext(
                    row.provider,
                    row.organization_id,
                    row.oauth_client_id,
                  ),
                )
                .toString("utf8"),
            }
          : null,
    };
  } catch {
    throw new CloudError(
      503,
      "credential_storage",
      `The ${gitProviderLabels[row.provider]} token cannot be unlocked. Connect ${gitProviderLabels[row.provider]} again.`,
    );
  }
}

const storedColumns =
  "organization_id,provider,api_url,account,secret,webhook_id,webhook_secret,actor_id,automate,oauth_client_id,oauth_secret";

export async function gitConnection(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  organizationId: string,
  provider: GitProvider,
): Promise<GitConnectionRecord> {
  const storage = await requireCredentialStorage(sql, cipher);
  const row = (
    await sql.query<StoredConnection>(
      `SELECT ${storedColumns} FROM cloud_git_connections WHERE organization_id=$1 AND provider=$2`,
      [organizationId, provider],
    )
  ).rows[0];
  if (!row) throw unconfigured(provider);
  return unlock(storage, row);
}

export async function gitConnectionByWebhook(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  provider: GitProvider,
  webhookId: string,
): Promise<GitConnectionRecord | null> {
  const row = (
    await sql.query<StoredConnection>(
      `SELECT ${storedColumns} FROM cloud_git_connections WHERE webhook_id=$1 AND provider=$2`,
      [webhookId, provider],
    )
  ).rows[0];
  return row ? unlock(await requireCredentialStorage(sql, cipher), row) : null;
}

export class CloudGitConnections {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
    private readonly transport: typeof fetch,
  ) {}

  oauthCallbackUrl(provider: GitProvider): string {
    return `${this.origin}/api/v1/integrations/${provider}/oauth/callback`;
  }

  webhookUrl(provider: GitProvider, webhookId: string): string {
    return `${this.origin}/api/v1/integrations/${provider}/webhooks/${webhookId}`;
  }

  private async read(
    sql: CloudSql,
    organizationId: string,
    provider: GitProvider,
  ): Promise<GitConnection | null> {
    const row = (
      await sql.query<
        Omit<
          GitConnection,
          "webhookUrl" | "webhookSecret" | "repositories" | "oauthCallbackUrl"
        >
      >(
        `SELECT provider,api_url AS "apiUrl",account,token_prefix AS "tokenPrefix",automate,revision,oauth_client_id AS "oauthClientId",
        to_char(connected_at AT TIME ZONE 'UTC',${timestamp}) AS "connectedAt",
        to_char(synced_at AT TIME ZONE 'UTC',${timestamp}) AS "syncedAt",last_error AS "lastError"
        FROM cloud_git_connections WHERE organization_id=$1 AND provider=$2`,
        [organizationId, provider],
      )
    ).rows[0];
    if (!row) return null;
    const record = await gitConnection(
      sql,
      this.cipher,
      organizationId,
      provider,
    );
    const repositories = (
      await sql.query<GitRepository & Record<string, unknown>>(
        `SELECT id,full_name AS "fullName",private,default_branch AS "defaultBranch",hook_id IS NOT NULL AS webhook,
        to_char(synced_at AT TIME ZONE 'UTC',${timestamp}) AS "syncedAt"
        FROM cloud_git_repositories WHERE organization_id=$1 AND provider=$2 ORDER BY lower(full_name)`,
        [organizationId, provider],
      )
    ).rows;
    return {
      ...row,
      webhookUrl: this.webhookUrl(provider, record.webhookId),
      oauthCallbackUrl: this.oauthCallbackUrl(provider),
      webhookSecret: record.webhookSecret,
      repositories,
    };
  }

  get(actor: CloudActor): Promise<GitAdministration> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const connections: GitAdministration["connections"] = {};
      for (const provider of gitProviders) {
        const connection = await this.read(sql, actor.organizationId, provider);
        if (connection) connections[provider] = connection;
      }
      return {
        connections,
        automations: Object.keys(connections).length
          ? await readStatusRules(sql, actor.organizationId)
          : [],
        credentialStorageAvailable: this.cipher !== null,
      };
    });
  }

  repositories(actor: CloudActor): Promise<GitRepositoryOption[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.view");
      return (
        await sql.query<GitRepositoryOption & Record<string, unknown>>(
          `SELECT id,provider,full_name AS "fullName" FROM cloud_git_repositories WHERE organization_id=$1 ORDER BY lower(full_name),id`,
          [actor.organizationId],
        )
      ).rows;
    });
  }

  async connect(
    actor: CloudActor,
    key: string,
    provider: GitProvider,
    input: GitConnectionInput,
  ): Promise<{ revision: number }> {
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "git.manage"),
    );
    const account = input.token
      ? await gitClient(
          { provider, apiUrl: input.apiUrl, token: input.token },
          this.transport,
        ).viewer()
      : null;
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const cipher = await requireCredentialStorage(sql, this.cipher);
      return command(
        sql,
        actor,
        key,
        {
          kind: "git.connection",
          provider,
          input: {
            ...input,
            token:
              input.token === undefined
                ? undefined
                : cipher.fingerprint(
                    Buffer.from(input.token),
                    Buffer.from(
                      `cloud.${provider}.command/${actor.organizationId}`,
                    ),
                  ),
            oauthClientSecret:
              input.oauthClientSecret === undefined
                ? undefined
                : cipher.fingerprint(
                    Buffer.from(input.oauthClientSecret),
                    Buffer.from(
                      `cloud.${provider}.oauth-command/${actor.organizationId}`,
                    ),
                  ),
          },
        },
        async () => {
          const current = (
            await sql.query<
              StoredConnection & { revision: number; token_prefix: string }
            >(
              `SELECT ${storedColumns},revision,token_prefix FROM cloud_git_connections WHERE organization_id=$1 AND provider=$2 FOR UPDATE`,
              [actor.organizationId, provider],
            )
          ).rows[0];
          checkRevision(current?.revision ?? 0, input.revision);
          if (!input.token && (!current || current.api_url !== input.apiUrl))
            throw new CloudError(
              422,
              "git_token_required",
              `Enter a ${gitProviderLabels[provider]} token for this API address.`,
            );
          const webhookId = current?.webhook_id ?? randomUUID();
          const webhookSecret =
            current?.webhook_secret ??
            cipher.encrypt(
              Buffer.from(randomBytes(32).toString("hex")),
              webhookContext(provider, actor.organizationId, webhookId),
            );
          const secret = input.token
            ? cipher.encrypt(
                Buffer.from(input.token),
                tokenContext(provider, actor.organizationId, input.apiUrl),
              )
            : Buffer.from(current!.secret);
          const oauthClientId =
            input.oauthClientId === undefined
              ? (current?.oauth_client_id ?? null)
              : input.oauthClientId;
          let oauthSecret: Buffer | null = null;
          if (oauthClientId && input.oauthClientSecret)
            oauthSecret = cipher.encrypt(
              Buffer.from(input.oauthClientSecret),
              oauthContext(provider, actor.organizationId, oauthClientId),
            );
          else if (
            oauthClientId &&
            current?.oauth_client_id === oauthClientId &&
            current.oauth_secret
          )
            oauthSecret = Buffer.from(current.oauth_secret);
          else if (oauthClientId)
            throw new CloudError(
              422,
              "git_oauth_secret_required",
              "Enter the OAuth app secret.",
            );
          const updated = (
            await sql.query<{ revision: number }>(
              `INSERT INTO cloud_git_connections (organization_id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id,automate,oauth_client_id,oauth_secret,sync_requested_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp())
              ON CONFLICT (organization_id,provider) DO UPDATE SET api_url=$3,secret=$4,token_prefix=$5,account=$6,actor_id=$9,automate=$10,oauth_client_id=$11,oauth_secret=$12,
              revision=cloud_git_connections.revision+1,last_error=NULL,sync_requested_at=clock_timestamp()
              RETURNING revision`,
              [
                actor.organizationId,
                provider,
                input.apiUrl,
                secret,
                input.token?.slice(0, 12) ?? current!.token_prefix,
                account ?? current!.account,
                webhookId,
                webhookSecret,
                actor.userId,
                input.automate,
                oauthClientId,
                oauthSecret,
              ],
            )
          ).rows[0]!;
          await recordEvent(
            sql,
            actor,
            "git.connected",
            actor.organizationId,
            updated.revision,
            {
              provider,
              automate: input.automate,
              tokenChanged: Boolean(input.token),
            },
          );
          return updated;
        },
      );
    });
  }

  private access(
    actor: CloudActor,
    provider: GitProvider,
  ): Promise<GitConnectionRecord> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      return gitConnection(sql, this.cipher, actor.organizationId, provider);
    });
  }

  async available(
    actor: CloudActor,
    provider: GitProvider,
  ): Promise<GitAvailableRepository[]> {
    return gitClient(
      await this.access(actor, provider),
      this.transport,
    ).repositories();
  }

  async addRepository(
    actor: CloudActor,
    provider: GitProvider,
    fullName: string,
  ): Promise<{ id: string }> {
    const access = await this.access(actor, provider);
    const client = gitClient(access, this.transport);
    const repository = await client.repository(fullName);
    const hookId = this.origin.startsWith("https://")
      ? await client
          .createWebhook(repository.fullName, {
            url: this.webhookUrl(provider, access.webhookId),
            secret: access.webhookSecret,
          })
          .catch((error: unknown) => {
            if (!isCloudError(error)) throw error;
            return null;
          })
      : null;
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const inserted = (
        await sql.query<{ id: string }>(
          `INSERT INTO cloud_git_repositories (organization_id,id,provider,external_id,full_name,default_branch,private,web_url,hook_id,hook_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (organization_id,provider,external_id)
          DO UPDATE SET full_name=$5,default_branch=$6,private=$7,web_url=$8,hook_id=COALESCE($9,cloud_git_repositories.hook_id),
          hook_version=CASE WHEN $9::bigint IS NULL THEN cloud_git_repositories.hook_version ELSE $10 END
          RETURNING id`,
          [
            actor.organizationId,
            randomUUID(),
            provider,
            repository.externalId,
            repository.fullName,
            repository.defaultBranch,
            repository.private,
            repository.webUrl.slice(0, 500),
            hookId,
            currentHookVersion,
          ],
        )
      ).rows[0]!;
      await sql.query(
        "UPDATE cloud_git_connections SET sync_requested_at=clock_timestamp() WHERE organization_id=$1 AND provider=$2",
        [actor.organizationId, provider],
      );
      await recordEvent(sql, actor, "git.repository_added", inserted.id, 1, {
        provider,
        fullName: repository.fullName,
      });
      return inserted;
    });
  }

  async removeRepository(actor: CloudActor, id: string): Promise<void> {
    const repository = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      return (
        await sql.query<{
          full_name: string;
          hook_id: string | null;
          provider: GitProvider;
        }>(
          "SELECT full_name,hook_id,provider FROM cloud_git_repositories WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      ).rows[0];
    });
    if (!repository)
      throw new CloudError(404, "not_found", "Repository is unavailable.");
    if (repository.hook_id)
      await gitClient(
        await this.access(actor, repository.provider),
        this.transport,
      )
        .deleteWebhook(repository.full_name, Number(repository.hook_id))
        .catch((error: unknown) => {
          if (!(error instanceof CloudError && error.status === 404))
            throw error;
        });
    await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      await sql.query(
        "DELETE FROM cloud_git_repositories WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
      await recordEvent(sql, actor, "git.repository_removed", id, 1, {
        provider: repository.provider,
        fullName: repository.full_name,
      });
    });
  }

  async disconnect(
    actor: CloudActor,
    provider: GitProvider,
    revision: number,
  ): Promise<void> {
    const webhooks = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const current = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_git_connections WHERE organization_id=$1 AND provider=$2",
          [actor.organizationId, provider],
        )
      ).rows[0];
      if (!current) return null;
      checkRevision(current.revision, revision);
      const hooks = (
        await sql.query<{ full_name: string; hook_id: string }>(
          "SELECT full_name,hook_id FROM cloud_git_repositories WHERE organization_id=$1 AND provider=$2 AND hook_id IS NOT NULL",
          [actor.organizationId, provider],
        )
      ).rows;
      return hooks.length
        ? {
            access: await gitConnection(
              sql,
              this.cipher,
              actor.organizationId,
              provider,
            ),
            hooks,
          }
        : null;
    });
    if (webhooks) {
      const client = gitClient(webhooks.access, this.transport);
      await Promise.all(
        webhooks.hooks.map((hook) =>
          client
            .deleteWebhook(hook.full_name, Number(hook.hook_id))
            .catch((error: unknown) => {
              if (!isCloudError(error)) throw error;
            }),
        ),
      );
    }
    await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const current = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_git_connections WHERE organization_id=$1 AND provider=$2 FOR UPDATE",
          [actor.organizationId, provider],
        )
      ).rows[0];
      if (!current) return;
      checkRevision(current.revision, revision);
      await sql.query(
        "DELETE FROM cloud_git_connections WHERE organization_id=$1 AND provider=$2",
        [actor.organizationId, provider],
      );
      await recordEvent(
        sql,
        actor,
        "git.disconnected",
        actor.organizationId,
        revision,
        { provider },
      );
    });
  }

  requestSync(actor: CloudActor, provider: GitProvider): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const updated = await sql.query(
        "UPDATE cloud_git_connections SET sync_requested_at=clock_timestamp() WHERE organization_id=$1 AND provider=$2 RETURNING organization_id",
        [actor.organizationId, provider],
      );
      if (!updated.rows.length) throw unconfigured(provider);
    });
  }
}
