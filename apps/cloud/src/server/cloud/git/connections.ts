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
import {
  gitHubInstallationRepositories,
  removeGitHubInstallation,
  type GitHubAppKey,
} from "./github-app";
import { providerWebOrigin, type OAuthApp } from "./oauth";
import { gitReviewSettings } from "./review-settings";

export const currentHookVersion = 4;

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export function tokenContext(
  provider: GitProvider,
  organizationId: string,
  apiUrl: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({ kind: `cloud.${provider}.token`, organizationId, apiUrl }),
  );
}

export function webhookContext(
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

export function oauthContext(
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

export interface GitHubAppInstallation {
  id: number;
  slug: string;
  installationId: number;
}

export interface GitConnectionRecord extends GitAccess {
  id: string;
  organizationId: string;
  account: string;
  app: GitHubAppInstallation | null;
  oauth: OAuthApp | null;
  webhookId: string;
  webhookSecret: string;
  actorId: string;
  automate: boolean;
  codeAccess: boolean;
}

type StoredConnection = {
  id: string;
  organization_id: string;
  provider: GitProvider;
  api_url: string;
  account: string;
  secret: Uint8Array;
  webhook_id: string;
  webhook_secret: Uint8Array;
  actor_id: string;
  automate: boolean;
  code_access: boolean;
  oauth_client_id: string | null;
  oauth_secret: Uint8Array | null;
  app_id: string | null;
  app_slug: string | null;
  app_installation_id: string | null;
};

function unconfigured(): CloudError {
  return new CloudError(
    404,
    "git_unconfigured",
    "This Git connection is unavailable.",
  );
}

export function requireCodeAccess(
  connection: GitConnectionRecord,
): GitConnectionRecord {
  if (!connection.codeAccess)
    throw new CloudError(
      409,
      "git_code_access",
      `Code access is off for ${connection.account}.`,
    );
  return connection;
}

function unlock(
  cipher: SettingsCipher,
  row: StoredConnection,
): GitConnectionRecord {
  try {
    return {
      id: row.id,
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
      codeAccess: row.code_access,
      app:
        row.app_id && row.app_slug && row.app_installation_id
          ? {
              id: Number(row.app_id),
              slug: row.app_slug,
              installationId: Number(row.app_installation_id),
            }
          : null,
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

export function appKeyContext(
  organizationId: string,
  connectionId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: "cloud.github.app-key",
      organizationId,
      connectionId,
    }),
  );
}

export async function gitHubAppKey(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  organizationId: string,
  connectionId: string,
): Promise<GitHubAppKey | null> {
  const row = (
    await sql.query<{ app_id: string | null; app_key: Uint8Array | null }>(
      "SELECT app_id,app_key FROM cloud_git_connections WHERE organization_id=$1 AND id=$2",
      [organizationId, connectionId],
    )
  ).rows[0];
  if (!row?.app_id || !row.app_key) return null;
  const storage = await requireCredentialStorage(sql, cipher);
  try {
    return {
      appId: Number(row.app_id),
      privateKey: storage
        .decrypt(
          Buffer.from(row.app_key),
          appKeyContext(organizationId, connectionId),
        )
        .toString("utf8"),
    };
  } catch {
    throw new CloudError(
      503,
      "credential_storage",
      "The GitHub App key cannot be unlocked. Connect GitHub again.",
    );
  }
}

const storedColumns =
  "id,organization_id,provider,api_url,account,secret,webhook_id,webhook_secret,actor_id,automate,code_access,oauth_client_id,oauth_secret,app_id,app_slug,app_installation_id";

export async function gitConnection(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  organizationId: string,
  connectionId: string,
): Promise<GitConnectionRecord> {
  const storage = await requireCredentialStorage(sql, cipher);
  const row = (
    await sql.query<StoredConnection>(
      `SELECT ${storedColumns} FROM cloud_git_connections WHERE organization_id=$1 AND id=$2`,
      [organizationId, connectionId],
    )
  ).rows[0];
  if (!row) throw unconfigured();
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

  get(actor: CloudActor): Promise<GitAdministration> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const rows = (
        await sql.query<
          Omit<
            GitConnection,
            | "webhookUrl"
            | "webhookSecret"
            | "repositories"
            | "oauthCallbackUrl"
            | "app"
          >
        >(
          `SELECT c.id,c.provider,c.api_url AS "apiUrl",c.account,c.token_prefix AS "tokenPrefix",c.automate,c.code_access AS "codeAccess",
          c.revision,c.oauth_client_id AS "oauthClientId",u.name AS "enabledBy",
          to_char(c.connected_at AT TIME ZONE 'UTC',${timestamp}) AS "connectedAt",
          to_char(c.synced_at AT TIME ZONE 'UTC',${timestamp}) AS "syncedAt",c.last_error AS "lastError",
          (SELECT to_char(max(d.received_at) AT TIME ZONE 'UTC',${timestamp}) FROM cloud_git_deliveries d WHERE d.organization_id=c.organization_id AND d.connection_id=c.id) AS "lastDeliveryAt"
          FROM cloud_git_connections c LEFT JOIN cloud_users u ON u.id=c.actor_id
          WHERE c.organization_id=$1 ORDER BY c.provider,c.connected_at,c.id`,
          [actor.organizationId],
        )
      ).rows;
      const connections: GitConnection[] = [];
      for (const row of rows) {
        const record = await gitConnection(
          sql,
          this.cipher,
          actor.organizationId,
          row.id,
        );
        const repositories = (
          await sql.query<GitRepository & Record<string, unknown>>(
            `SELECT id,full_name AS "fullName",private,default_branch AS "defaultBranch",hook_id IS NOT NULL AS webhook,
            to_char(synced_at AT TIME ZONE 'UTC',${timestamp}) AS "syncedAt",team_id AS "teamId",issue_sync AS "issueSync"
            FROM cloud_git_repositories WHERE organization_id=$1 AND connection_id=$2 ORDER BY lower(full_name)`,
            [actor.organizationId, row.id],
          )
        ).rows;
        connections.push({
          ...row,
          webhookUrl: this.webhookUrl(row.provider, record.webhookId),
          oauthCallbackUrl: this.oauthCallbackUrl(row.provider),
          webhookSecret: record.webhookSecret,
          app: record.app && {
            slug: record.app.slug,
            configureUrl: `${providerWebOrigin(record.provider, record.apiUrl)}/apps/${record.app.slug}/installations/new`,
          },
          repositories: record.app
            ? repositories.map((repository) => ({
                ...repository,
                webhook: true,
              }))
            : repositories,
        });
      }
      return {
        connections,
        automations: connections.length
          ? await readStatusRules(sql, actor.organizationId)
          : [],
        settings: await gitReviewSettings(sql, actor.organizationId),
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
  ): Promise<{ id: string; revision: number }> {
    await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      if (!input.connectionId) return;
      const app = (
        await sql.query<{ api_url: string; oauth_client_id: string | null }>(
          "SELECT api_url,oauth_client_id FROM cloud_git_connections WHERE organization_id=$1 AND id=$2 AND app_id IS NOT NULL",
          [actor.organizationId, input.connectionId],
        )
      ).rows[0];
      if (
        app &&
        (input.token ||
          input.oauthClientSecret ||
          app.api_url !== input.apiUrl ||
          (input.oauthClientId !== undefined &&
            input.oauthClientId !== app.oauth_client_id))
      )
        throw new CloudError(
          409,
          "git_app_managed",
          "This connection is managed by its GitHub App.",
        );
    });
    const viewer = input.token
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
          const current = input.connectionId
            ? (
                await sql.query<
                  StoredConnection & { revision: number; token_prefix: string }
                >(
                  `SELECT ${storedColumns},revision,token_prefix FROM cloud_git_connections WHERE organization_id=$1 AND id=$2 AND provider=$3 FOR UPDATE`,
                  [actor.organizationId, input.connectionId, provider],
                )
              ).rows[0]
            : undefined;
          if (input.connectionId && !current) throw unconfigured();
          checkRevision(current?.revision ?? 0, input.revision);
          if (!input.token && (!current || current.api_url !== input.apiUrl))
            throw new CloudError(
              422,
              "git_token_required",
              `Enter a ${gitProviderLabels[provider]} token for this API address.`,
            );
          const id = current?.id ?? randomUUID();
          const account = viewer ?? current!.account;
          const duplicate = await sql.query(
            "SELECT 1 FROM cloud_git_connections WHERE organization_id=$1 AND provider=$2 AND api_url=$3 AND lower(account)=lower($4) AND id<>$5",
            [actor.organizationId, provider, input.apiUrl, account, id],
          );
          if (duplicate.rows.length)
            throw new CloudError(
              409,
              "git_connection_exists",
              `${account} is already connected.`,
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
          const values = [
            actor.organizationId,
            id,
            input.apiUrl,
            secret,
            input.token?.slice(0, 12) ?? current!.token_prefix,
            account,
            actor.userId,
            input.automate,
            input.codeAccess,
            oauthClientId,
            oauthSecret,
          ];
          const updated = current
            ? (
                await sql.query<{ revision: number }>(
                  `UPDATE cloud_git_connections SET api_url=$3,secret=$4,token_prefix=$5,account=$6,automate=$8,code_access=$9,oauth_client_id=$10,oauth_secret=$11,
                  actor_id=CASE WHEN $12 THEN $7 ELSE actor_id END,connected_at=CASE WHEN $12 THEN clock_timestamp() ELSE connected_at END,
                  revision=revision+1,last_error=NULL,sync_requested_at=clock_timestamp()
                  WHERE organization_id=$1 AND id=$2 RETURNING revision`,
                  [...values, Boolean(input.token)],
                )
              ).rows[0]!
            : (
                await sql.query<{ revision: number }>(
                  `INSERT INTO cloud_git_connections (organization_id,id,api_url,secret,token_prefix,account,actor_id,automate,code_access,oauth_client_id,oauth_secret,
                  provider,webhook_id,webhook_secret,sync_requested_at)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()) RETURNING revision`,
                  [...values, provider, webhookId, webhookSecret],
                )
              ).rows[0]!;
          await recordEvent(sql, actor, "git.connected", id, updated.revision, {
            provider,
            account,
            automate: input.automate,
            codeAccess: input.codeAccess,
            tokenChanged: Boolean(input.token),
          });
          return { id, revision: updated.revision };
        },
      );
    });
  }

  private access(
    actor: CloudActor,
    connectionId: string,
  ): Promise<GitConnectionRecord> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      return gitConnection(
        sql,
        this.cipher,
        actor.organizationId,
        connectionId,
      );
    });
  }

  async available(
    actor: CloudActor,
    connectionId: string,
  ): Promise<GitAvailableRepository[]> {
    const access = await this.access(actor, connectionId);
    return access.app
      ? gitHubInstallationRepositories(access, this.transport)
      : gitClient(access, this.transport).repositories();
  }

  async addRepository(
    actor: CloudActor,
    connectionId: string,
    fullName: string,
  ): Promise<{ id: string }> {
    const access = await this.access(actor, connectionId);
    const client = gitClient(access, this.transport);
    const repository = await client.repository(fullName);
    const hookId =
      !access.app && this.origin.startsWith("https://")
        ? await client
            .createWebhook(repository.fullName, {
              url: this.webhookUrl(access.provider, access.webhookId),
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
          `INSERT INTO cloud_git_repositories (organization_id,id,provider,external_id,full_name,default_branch,private,web_url,hook_id,hook_version,connection_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (organization_id,provider,external_id)
          DO UPDATE SET full_name=$5,default_branch=$6,private=$7,web_url=$8,connection_id=$11,hook_id=COALESCE($9,cloud_git_repositories.hook_id),
          hook_version=CASE WHEN $9::bigint IS NULL THEN cloud_git_repositories.hook_version ELSE $10 END
          RETURNING id`,
          [
            actor.organizationId,
            randomUUID(),
            access.provider,
            repository.externalId,
            repository.fullName,
            repository.defaultBranch,
            repository.private,
            repository.webUrl.slice(0, 500),
            hookId,
            currentHookVersion,
            connectionId,
          ],
        )
      ).rows[0]!;
      await sql.query(
        "UPDATE cloud_git_connections SET sync_requested_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, connectionId],
      );
      await recordEvent(sql, actor, "git.repository_added", inserted.id, 1, {
        provider: access.provider,
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
          connection_id: string;
        }>(
          "SELECT full_name,hook_id,provider,connection_id FROM cloud_git_repositories WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      ).rows[0];
    });
    if (!repository)
      throw new CloudError(404, "not_found", "Repository is unavailable.");
    if (repository.hook_id)
      await gitClient(
        await this.access(actor, repository.connection_id),
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
    connectionId: string,
    revision: number,
  ): Promise<void> {
    const webhooks = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const current = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_git_connections WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, connectionId],
        )
      ).rows[0];
      if (!current) return null;
      checkRevision(current.revision, revision);
      const app = await gitHubAppKey(
        sql,
        this.cipher,
        actor.organizationId,
        connectionId,
      );
      const hooks = (
        await sql.query<{ full_name: string; hook_id: string }>(
          "SELECT full_name,hook_id FROM cloud_git_repositories WHERE organization_id=$1 AND connection_id=$2 AND hook_id IS NOT NULL",
          [actor.organizationId, connectionId],
        )
      ).rows;
      return {
        access: await gitConnection(
          sql,
          this.cipher,
          actor.organizationId,
          connectionId,
        ),
        hooks,
        app,
      };
    });
    if (webhooks?.app && webhooks.access.app)
      await removeGitHubInstallation(
        webhooks.access.apiUrl,
        webhooks.app,
        webhooks.access.app.installationId,
        this.transport,
      ).catch((error: unknown) => {
        if (!isCloudError(error)) throw error;
      });
    if (webhooks?.hooks.length) {
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
        await sql.query<{ revision: number; provider: GitProvider }>(
          "SELECT revision,provider FROM cloud_git_connections WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [actor.organizationId, connectionId],
        )
      ).rows[0];
      if (!current) return;
      checkRevision(current.revision, revision);
      await sql.query(
        "DELETE FROM cloud_git_connections WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, connectionId],
      );
      await recordEvent(
        sql,
        actor,
        "git.disconnected",
        connectionId,
        revision,
        { provider: current.provider },
      );
    });
  }

  requestSync(actor: CloudActor, connectionId: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const updated = await sql.query(
        "UPDATE cloud_git_connections SET sync_requested_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 RETURNING organization_id",
        [actor.organizationId, connectionId],
      );
      if (!updated.rows.length) throw unconfigured();
    });
  }
}
