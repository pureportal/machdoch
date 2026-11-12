import { randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  GitHubAdministration,
  GitHubAvailableRepository,
  GitHubConnection,
  GitHubConnectionInput,
  GitHubRepository,
} from "../../../lib/cloud-github-contract";
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
import { readAutomations } from "./automations";
import { GitHubClient, type GitHubAccess } from "./client";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function tokenContext(organizationId: string, apiUrl: string): Buffer {
  return Buffer.from(
    JSON.stringify({ kind: "cloud.github.token", organizationId, apiUrl }),
  );
}

function webhookContext(organizationId: string, webhookId: string): Buffer {
  return Buffer.from(
    JSON.stringify({ kind: "cloud.github.webhook", organizationId, webhookId }),
  );
}

export interface GitHubConnectionRecord extends GitHubAccess {
  organizationId: string;
  webhookId: string;
  webhookSecret: string;
  actorId: string;
  automate: boolean;
}

type StoredConnection = {
  organization_id: string;
  api_url: string;
  secret: Uint8Array;
  webhook_id: string;
  webhook_secret: Uint8Array;
  actor_id: string;
  automate: boolean;
};

function unlock(
  cipher: SettingsCipher,
  row: StoredConnection,
): GitHubConnectionRecord {
  try {
    return {
      organizationId: row.organization_id,
      apiUrl: row.api_url,
      token: cipher
        .decrypt(
          Buffer.from(row.secret),
          tokenContext(row.organization_id, row.api_url),
        )
        .toString("utf8"),
      webhookId: row.webhook_id,
      webhookSecret: cipher
        .decrypt(
          Buffer.from(row.webhook_secret),
          webhookContext(row.organization_id, row.webhook_id),
        )
        .toString("utf8"),
      actorId: row.actor_id,
      automate: row.automate,
    };
  } catch {
    throw new CloudError(
      503,
      "credential_storage",
      "The GitHub token cannot be unlocked. Connect GitHub again.",
    );
  }
}

const storedColumns =
  "organization_id,api_url,secret,webhook_id,webhook_secret,actor_id,automate";

export async function githubConnection(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  organizationId: string,
): Promise<GitHubConnectionRecord> {
  const storage = await requireCredentialStorage(sql, cipher);
  const row = (
    await sql.query<StoredConnection>(
      `SELECT ${storedColumns} FROM cloud_github_connections WHERE organization_id=$1`,
      [organizationId],
    )
  ).rows[0];
  if (!row)
    throw new CloudError(409, "github_unconfigured", "Connect GitHub first.");
  return unlock(storage, row);
}

export async function githubConnectionByWebhook(
  sql: CloudSql,
  cipher: SettingsCipher | null,
  webhookId: string,
): Promise<GitHubConnectionRecord | null> {
  const row = (
    await sql.query<StoredConnection>(
      `SELECT ${storedColumns} FROM cloud_github_connections WHERE webhook_id=$1`,
      [webhookId],
    )
  ).rows[0];
  return row ? unlock(await requireCredentialStorage(sql, cipher), row) : null;
}

export class CloudGitHubConnections {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
    private readonly transport: typeof fetch,
  ) {}

  webhookUrl(webhookId: string): string {
    return `${this.origin}/api/v1/integrations/github/webhooks/${webhookId}`;
  }

  private async read(
    sql: CloudSql,
    organizationId: string,
  ): Promise<GitHubConnection | null> {
    const row = (
      await sql.query<
        Omit<GitHubConnection, "webhookUrl" | "webhookSecret" | "repositories">
      >(
        `SELECT api_url AS "apiUrl",account,token_prefix AS "tokenPrefix",automate,revision,
        to_char(connected_at AT TIME ZONE 'UTC',${timestamp}) AS "connectedAt",
        to_char(synced_at AT TIME ZONE 'UTC',${timestamp}) AS "syncedAt",last_error AS "lastError"
        FROM cloud_github_connections WHERE organization_id=$1`,
        [organizationId],
      )
    ).rows[0];
    if (!row) return null;
    const record = await githubConnection(sql, this.cipher, organizationId);
    const repositories = (
      await sql.query<GitHubRepository & Record<string, unknown>>(
        `SELECT id,full_name AS "fullName",private,default_branch AS "defaultBranch",hook_id IS NOT NULL AS webhook,
        to_char(synced_at AT TIME ZONE 'UTC',${timestamp}) AS "syncedAt"
        FROM cloud_github_repositories WHERE organization_id=$1 ORDER BY lower(full_name)`,
        [organizationId],
      )
    ).rows;
    return {
      ...row,
      webhookUrl: this.webhookUrl(record.webhookId),
      webhookSecret: record.webhookSecret,
      repositories,
    };
  }

  get(actor: CloudActor): Promise<GitHubAdministration> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const connection = await this.read(sql, actor.organizationId);
      return {
        connection,
        automations: connection
          ? await readAutomations(sql, actor.organizationId)
          : [],
        credentialStorageAvailable: this.cipher !== null,
      };
    });
  }

  async connect(
    actor: CloudActor,
    key: string,
    input: GitHubConnectionInput,
  ): Promise<{ revision: number }> {
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "admin"),
    );
    const account = input.token
      ? await new GitHubClient(
          { apiUrl: input.apiUrl, token: input.token },
          this.transport,
        ).viewer()
      : null;
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const cipher = await requireCredentialStorage(sql, this.cipher);
      return command(
        sql,
        actor,
        key,
        {
          kind: "github.connection",
          input: {
            ...input,
            token:
              input.token === undefined
                ? undefined
                : cipher.fingerprint(
                    Buffer.from(input.token),
                    Buffer.from(`cloud.github.command/${actor.organizationId}`),
                  ),
          },
        },
        async () => {
          const current = (
            await sql.query<
              StoredConnection & {
                revision: number;
                account: string;
                token_prefix: string;
              }
            >(
              `SELECT ${storedColumns},revision,account,token_prefix FROM cloud_github_connections WHERE organization_id=$1 FOR UPDATE`,
              [actor.organizationId],
            )
          ).rows[0];
          checkRevision(current?.revision ?? 0, input.revision);
          if (!input.token && (!current || current.api_url !== input.apiUrl))
            throw new CloudError(
              422,
              "github_token_required",
              "Enter a GitHub token for this API address.",
            );
          const webhookId = current?.webhook_id ?? randomUUID();
          const webhookSecret =
            current?.webhook_secret ??
            cipher.encrypt(
              Buffer.from(randomBytes(32).toString("hex")),
              webhookContext(actor.organizationId, webhookId),
            );
          const secret = input.token
            ? cipher.encrypt(
                Buffer.from(input.token),
                tokenContext(actor.organizationId, input.apiUrl),
              )
            : Buffer.from(current!.secret);
          const updated = (
            await sql.query<{ revision: number }>(
              `INSERT INTO cloud_github_connections (organization_id,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id,automate,sync_requested_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
              ON CONFLICT (organization_id) DO UPDATE SET api_url=$2,secret=$3,token_prefix=$4,account=$5,actor_id=$8,automate=$9,
              revision=cloud_github_connections.revision+1,last_error=NULL,sync_requested_at=clock_timestamp()
              RETURNING revision`,
              [
                actor.organizationId,
                input.apiUrl,
                secret,
                input.token?.slice(0, 12) ?? current!.token_prefix,
                account ?? current!.account,
                webhookId,
                webhookSecret,
                actor.userId,
                input.automate,
              ],
            )
          ).rows[0]!;
          await recordEvent(
            sql,
            actor,
            "github.connected",
            actor.organizationId,
            updated.revision,
            { automate: input.automate, tokenChanged: Boolean(input.token) },
          );
          return updated;
        },
      );
    });
  }

  private access(actor: CloudActor): Promise<GitHubConnectionRecord> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return githubConnection(sql, this.cipher, actor.organizationId);
    });
  }

  async available(actor: CloudActor): Promise<GitHubAvailableRepository[]> {
    const access = await this.access(actor);
    return (await new GitHubClient(access, this.transport).repositories()).map(
      (repository) => ({
        fullName: repository.full_name,
        private: repository.private,
      }),
    );
  }

  async addRepository(
    actor: CloudActor,
    fullName: string,
  ): Promise<{ id: string }> {
    const access = await this.access(actor);
    const client = new GitHubClient(access, this.transport);
    const repository = await client.repository(fullName);
    const hookId = this.origin.startsWith("https://")
      ? await client
          .createWebhook(
            repository.full_name,
            this.webhookUrl(access.webhookId),
            access.webhookSecret,
          )
          .catch((error: unknown) => {
            if (!isCloudError(error)) throw error;
            return null;
          })
      : null;
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const inserted = (
        await sql.query<{ id: string }>(
          `INSERT INTO cloud_github_repositories (organization_id,id,github_id,full_name,default_branch,private,hook_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id,github_id)
          DO UPDATE SET full_name=$4,default_branch=$5,private=$6,hook_id=COALESCE($7,cloud_github_repositories.hook_id)
          RETURNING id`,
          [
            actor.organizationId,
            randomUUID(),
            repository.id,
            repository.full_name,
            repository.default_branch,
            repository.private,
            hookId,
          ],
        )
      ).rows[0]!;
      await sql.query(
        "UPDATE cloud_github_connections SET sync_requested_at=clock_timestamp() WHERE organization_id=$1",
        [actor.organizationId],
      );
      await recordEvent(sql, actor, "github.repository_added", inserted.id, 1, {
        fullName: repository.full_name,
      });
      return inserted;
    });
  }

  async removeRepository(actor: CloudActor, id: string): Promise<void> {
    const access = await this.access(actor);
    const repository = await this.database.transaction(
      async (sql) =>
        (
          await sql.query<{ full_name: string; hook_id: string | null }>(
            "SELECT full_name,hook_id FROM cloud_github_repositories WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id],
          )
        ).rows[0],
    );
    if (!repository)
      throw new CloudError(404, "not_found", "Repository is unavailable.");
    if (repository.hook_id)
      await new GitHubClient(access, this.transport)
        .deleteWebhook(repository.full_name, Number(repository.hook_id))
        .catch((error: unknown) => {
          if (!(error instanceof CloudError && error.status === 404))
            throw error;
        });
    await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      await sql.query(
        "DELETE FROM cloud_github_repositories WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
      await recordEvent(sql, actor, "github.repository_removed", id, 1, {
        fullName: repository.full_name,
      });
    });
  }

  async disconnect(actor: CloudActor, revision: number): Promise<void> {
    const webhooks = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const current = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_github_connections WHERE organization_id=$1",
          [actor.organizationId],
        )
      ).rows[0];
      if (!current) return null;
      checkRevision(current.revision, revision);
      const hooks = (
        await sql.query<{ full_name: string; hook_id: string }>(
          "SELECT full_name,hook_id FROM cloud_github_repositories WHERE organization_id=$1 AND hook_id IS NOT NULL",
          [actor.organizationId],
        )
      ).rows;
      return hooks.length
        ? {
            access: await githubConnection(
              sql,
              this.cipher,
              actor.organizationId,
            ),
            hooks,
          }
        : null;
    });
    if (webhooks) {
      const client = new GitHubClient(webhooks.access, this.transport);
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
      await requireMembership(sql, actor, "admin");
      const current = (
        await sql.query<{ revision: number }>(
          "SELECT revision FROM cloud_github_connections WHERE organization_id=$1 FOR UPDATE",
          [actor.organizationId],
        )
      ).rows[0];
      if (!current) return;
      checkRevision(current.revision, revision);
      await sql.query(
        "DELETE FROM cloud_github_connections WHERE organization_id=$1",
        [actor.organizationId],
      );
      await recordEvent(
        sql,
        actor,
        "github.disconnected",
        actor.organizationId,
        revision,
        {},
      );
    });
  }

  requestSync(actor: CloudActor): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const updated = await sql.query(
        "UPDATE cloud_github_connections SET sync_requested_at=clock_timestamp() WHERE organization_id=$1 RETURNING organization_id",
        [actor.organizationId],
      );
      if (!updated.rows.length)
        throw new CloudError(
          409,
          "github_unconfigured",
          "Connect GitHub first.",
        );
    });
  }
}
