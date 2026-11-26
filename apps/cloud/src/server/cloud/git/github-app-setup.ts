import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { GitHubAppSetupInput } from "../../../lib/cloud-git-contract";
import type { SettingsCipher } from "../../settings-crypto";
import {
  CloudError,
  isCloudError,
  recordEvent,
  requireMembership,
} from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import {
  appKeyContext,
  gitHubAppKey,
  oauthContext,
  tokenContext,
  webhookContext,
} from "./connections";
import {
  convertGitHubAppManifest,
  gitHubAppCreationUrl,
  gitHubAppInstallUrl,
  gitHubAppManifest,
  gitHubAppName,
  gitHubInstallationAccount,
  gitHubInstallationToken,
  type GitHubAppKey,
  type GitHubInstallationToken,
} from "./github-app";

const setupLifetimeHours = 24;
const refreshLeadMs = 15 * 60_000;
const retryDelayMinutes = 5;
const refreshBatchSize = 5;

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function setupContext(stateDigest: string, purpose: string): Buffer {
  return Buffer.from(
    JSON.stringify({ kind: `cloud.github.app-setup.${purpose}`, stateDigest }),
  );
}

function expired(): CloudError {
  return new CloudError(
    400,
    "git_app_setup",
    "This GitHub setup expired. Start again.",
  );
}

interface StoredSetup extends Record<string, unknown> {
  organization_id: string;
  user_id: string;
  api_url: string;
  owner: string | null;
  webhook_id: string;
  app_id: string | null;
  app_slug: string | null;
  client_id: string | null;
  client_secret: Uint8Array | null;
  webhook_secret: Uint8Array | null;
  app_key: Uint8Array | null;
}

export interface GitHubAppUrls {
  origin: string;
  webhookUrl: (webhookId: string) => string;
  oauthCallbackUrl: string;
}

export class CloudGitHubApps {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch,
    private readonly urls: GitHubAppUrls,
  ) {}

  private callbackUrl(step: "start" | "created" | "installed"): string {
    return `${this.urls.origin}/api/v1/integrations/github/app/${step}`;
  }

  start(
    actor: CloudActor,
    input: GitHubAppSetupInput,
  ): Promise<{ url: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      await requireCredentialStorage(sql, this.cipher);
      await sql.query(
        `DELETE FROM cloud_git_app_setups WHERE created_at < clock_timestamp() - interval '${setupLifetimeHours} hours'`,
      );
      const state = randomBytes(32).toString("base64url");
      await sql.query(
        "INSERT INTO cloud_git_app_setups (state_hash,organization_id,user_id,api_url,owner,webhook_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          stateHash(state),
          actor.organizationId,
          actor.userId,
          input.apiUrl,
          input.owner,
          randomUUID(),
        ],
      );
      const url = new URL(this.callbackUrl("start"));
      url.searchParams.set("state", state);
      return { url: url.href };
    });
  }

  async registration(
    state: string,
  ): Promise<{ action: string; manifest: string }> {
    const setup = await this.database.transaction(async (sql) => {
      const stored = await this.pending(sql, state);
      if (!stored || stored.app_id) return null;
      const organization = (
        await sql.query<{ name: string }>(
          "SELECT name FROM cloud_organizations WHERE id=$1",
          [stored.organization_id],
        )
      ).rows[0]!.name;
      return { ...stored, organization };
    });
    if (!setup) throw expired();
    return {
      action: gitHubAppCreationUrl(setup.api_url, setup.owner, state),
      manifest: JSON.stringify(
        gitHubAppManifest({
          name: gitHubAppName(setup.organization),
          homepageUrl: this.urls.origin,
          webhookUrl: this.urls.webhookUrl(setup.webhook_id),
          webhookActive: this.urls.origin.startsWith("https://"),
          redirectUrl: this.callbackUrl("created"),
          callbackUrl: this.urls.oauthCallbackUrl,
          setupUrl: this.callbackUrl("installed"),
        }),
      ),
    };
  }

  private pending(sql: CloudSql, state: string): Promise<StoredSetup | null> {
    return sql
      .query<StoredSetup>(
        `SELECT organization_id,user_id,api_url,owner,webhook_id,app_id,app_slug,client_id,client_secret,webhook_secret,app_key
        FROM cloud_git_app_setups WHERE state_hash=$1 AND created_at > clock_timestamp() - interval '${setupLifetimeHours} hours' FOR UPDATE`,
        [stateHash(state)],
      )
      .then((result) => result.rows[0] ?? null);
  }

  async created(code: string, state: string): Promise<string> {
    const setup = await this.database.transaction((sql) =>
      this.pending(sql, state),
    );
    if (!setup) throw expired();
    if (setup.app_slug)
      return gitHubAppInstallUrl(setup.api_url, setup.app_slug, state);
    const app = await convertGitHubAppManifest(
      setup.api_url,
      code,
      this.transport,
    );
    await this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const digest = stateHash(state);
      const updated = await sql.query(
        `UPDATE cloud_git_app_setups SET app_id=$2,app_slug=$3,client_id=$4,client_secret=$5,webhook_secret=$6,app_key=$7
        WHERE state_hash=$1 AND app_id IS NULL RETURNING state_hash`,
        [
          digest,
          app.appId,
          app.slug,
          app.clientId,
          cipher.encrypt(
            Buffer.from(app.clientSecret),
            setupContext(digest, "client-secret"),
          ),
          cipher.encrypt(
            Buffer.from(app.webhookSecret),
            setupContext(digest, "webhook-secret"),
          ),
          cipher.encrypt(
            Buffer.from(app.privateKey),
            setupContext(digest, "key"),
          ),
        ],
      );
      if (!updated.rows.length) throw expired();
    });
    return gitHubAppInstallUrl(setup.api_url, app.slug, state);
  }

  async installed(installationId: number, state: string): Promise<string> {
    const digest = stateHash(state);
    const setup = await this.database.transaction(async (sql) => {
      const stored = await this.pending(sql, state);
      if (!stored?.app_id || !stored.app_key) throw expired();
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const decrypt = (value: Uint8Array, purpose: string) =>
        cipher
          .decrypt(Buffer.from(value), setupContext(digest, purpose))
          .toString("utf8");
      return {
        ...stored,
        key: {
          appId: Number(stored.app_id),
          privateKey: decrypt(stored.app_key, "key"),
        },
        clientSecret: decrypt(stored.client_secret!, "client-secret"),
        webhookSecret: decrypt(stored.webhook_secret!, "webhook-secret"),
      };
    });
    const account = await gitHubInstallationAccount(
      setup.api_url,
      setup.key,
      installationId,
      this.transport,
    );
    const token = await gitHubInstallationToken(
      setup.api_url,
      setup.key,
      installationId,
      this.transport,
    );
    const actor = {
      organizationId: setup.organization_id,
      userId: setup.user_id,
    };
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "git.manage");
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const claimed = await sql.query(
        "DELETE FROM cloud_git_app_setups WHERE state_hash=$1 RETURNING state_hash",
        [digest],
      );
      if (!claimed.rows.length) throw expired();
      const duplicate = await sql.query(
        "SELECT 1 FROM cloud_git_connections WHERE organization_id=$1 AND provider='github' AND api_url=$2 AND lower(account)=lower($3)",
        [actor.organizationId, setup.api_url, account],
      );
      if (duplicate.rows.length)
        throw new CloudError(
          409,
          "git_connection_exists",
          `${account} is already connected.`,
        );
      const id = randomUUID();
      const { organizationId } = actor;
      await sql.query(
        `INSERT INTO cloud_git_connections (organization_id,id,provider,api_url,secret,token_prefix,account,actor_id,automate,code_access,
        oauth_client_id,oauth_secret,webhook_id,webhook_secret,app_id,app_slug,app_installation_id,app_key,token_refresh_at,sync_requested_at)
        VALUES ($1,$2,'github',$3,$4,$5,$6,$7,true,true,$8,$9,$10,$11,$12,$13,$14,$15,$16,clock_timestamp())`,
        [
          organizationId,
          id,
          setup.api_url,
          cipher.encrypt(
            Buffer.from(token.token),
            tokenContext("github", organizationId, setup.api_url),
          ),
          token.token.slice(0, 12),
          account,
          actor.userId,
          setup.client_id,
          cipher.encrypt(
            Buffer.from(setup.clientSecret),
            oauthContext("github", organizationId, setup.client_id!),
          ),
          setup.webhook_id,
          cipher.encrypt(
            Buffer.from(setup.webhookSecret),
            webhookContext("github", organizationId, setup.webhook_id),
          ),
          setup.key.appId,
          setup.app_slug,
          installationId,
          cipher.encrypt(
            Buffer.from(setup.key.privateKey),
            appKeyContext(organizationId, id),
          ),
          new Date(token.expiresAt.getTime() - refreshLeadMs),
        ],
      );
      await recordEvent(sql, actor, "git.connected", id, 1, {
        provider: "github",
        account,
        app: setup.app_slug,
      });
      return id;
    });
  }

  async refreshTokens(): Promise<number> {
    if (!this.cipher) return 0;
    const due = await this.database.transaction(async (sql) => {
      const rows = (
        await sql.query<{
          organization_id: string;
          id: string;
          api_url: string;
          app_installation_id: string;
        }>(
          `UPDATE cloud_git_connections SET token_refresh_at=clock_timestamp() + interval '${retryDelayMinutes} minutes'
          WHERE (organization_id,id) IN (
            SELECT organization_id,id FROM cloud_git_connections WHERE app_id IS NOT NULL AND token_refresh_at <= clock_timestamp()
            ORDER BY token_refresh_at LIMIT ${refreshBatchSize} FOR UPDATE SKIP LOCKED)
          RETURNING organization_id,id,api_url,app_installation_id`,
        )
      ).rows;
      const keyed: {
        organizationId: string;
        id: string;
        apiUrl: string;
        installationId: number;
        key: GitHubAppKey;
      }[] = [];
      for (const row of rows) {
        const key = await gitHubAppKey(
          sql,
          this.cipher,
          row.organization_id,
          row.id,
        );
        if (key)
          keyed.push({
            organizationId: row.organization_id,
            id: row.id,
            apiUrl: row.api_url,
            installationId: Number(row.app_installation_id),
            key,
          });
      }
      return keyed;
    });
    for (const connection of due) {
      let token: GitHubInstallationToken;
      try {
        token = await gitHubInstallationToken(
          connection.apiUrl,
          connection.key,
          connection.installationId,
          this.transport,
        );
      } catch (error) {
        if (!isCloudError(error)) throw error;
        await this.database.transaction((sql) =>
          sql.query(
            "UPDATE cloud_git_connections SET last_error=$3 WHERE organization_id=$1 AND id=$2",
            [
              connection.organizationId,
              connection.id,
              `GitHub App: ${error.message}`.slice(0, 500),
            ],
          ),
        );
        continue;
      }
      await this.database.transaction(async (sql) => {
        const cipher = await requireCredentialStorage(sql, this.cipher);
        await sql.query(
          `UPDATE cloud_git_connections SET secret=$3,token_prefix=$4,token_refresh_at=$5,
          last_error=CASE WHEN last_error LIKE 'GitHub App:%' THEN NULL ELSE last_error END
          WHERE organization_id=$1 AND id=$2`,
          [
            connection.organizationId,
            connection.id,
            cipher.encrypt(
              Buffer.from(token.token),
              tokenContext(
                "github",
                connection.organizationId,
                connection.apiUrl,
              ),
            ),
            token.token.slice(0, 12),
            new Date(token.expiresAt.getTime() - refreshLeadMs),
          ],
        );
      });
    }
    return due.length;
  }
}
