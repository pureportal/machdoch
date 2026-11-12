import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  socialNetworks,
  type SocialAccount,
  type SocialApp,
  type SocialNetwork,
  type SocialTarget,
  type SubredditFlair,
} from "../../../lib/cloud-release-contract";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, requireMembership } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import {
  authorizeUrl,
  LinkedInClient,
  RedditClient,
  SocialApiError,
  type OAuthApp,
  type SocialTokens,
} from "./social-clients";

const stateLifetimeMinutes = 10;
const refreshMarginMs = 5 * 60_000;

const appContext = (organizationId: string, network: SocialNetwork) =>
  Buffer.from(
    JSON.stringify({ kind: "cloud.social.app", organizationId, network }),
  );
const accountContext = (organizationId: string, id: string) =>
  Buffer.from(
    JSON.stringify({ kind: "cloud.social.account", organizationId, id }),
  );
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export interface SocialAccess {
  network: SocialNetwork;
  externalId: string;
  name: string;
  accessToken: string;
}

export function socialFailure(error: unknown): CloudError {
  if (error instanceof SocialApiError)
    return new CloudError(
      error.status === 401 || error.status === 403 ? 409 : 502,
      error.status === 401 ? "social_reconnect" : "social_unavailable",
      error.status === 401
        ? "The account sign-in expired. Reconnect it under Releases → Connections."
        : error.message,
    );
  return error instanceof CloudError
    ? error
    : new CloudError(502, "social_unavailable", "The network is unavailable.");
}

export class CloudSocial {
  readonly linkedin: LinkedInClient;
  readonly reddit: RedditClient;

  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
    transport: typeof fetch,
  ) {
    this.linkedin = new LinkedInClient(transport);
    this.reddit = new RedditClient(transport);
  }

  redirectUri(network: SocialNetwork): string {
    return `${this.origin}/api/v1/social/${network}/callback`;
  }

  private async app(
    sql: CloudSql,
    organizationId: string,
    network: SocialNetwork,
  ): Promise<OAuthApp> {
    const row = (
      await sql.query<{
        client_id: string;
        secret: Uint8Array;
        organization_pages: boolean;
      }>(
        "SELECT client_id,secret,organization_pages FROM cloud_social_apps WHERE organization_id=$1 AND network=$2",
        [organizationId, network],
      )
    ).rows[0];
    if (!row)
      throw new CloudError(
        409,
        "social_app_required",
        `Add the ${network === "linkedin" ? "LinkedIn" : "Reddit"} app credentials first.`,
      );
    const storage = await requireCredentialStorage(sql, this.cipher);
    return {
      clientId: row.client_id,
      clientSecret: storage
        .decrypt(Buffer.from(row.secret), appContext(organizationId, network))
        .toString("utf8"),
      redirectUri: this.redirectUri(network),
      organizationPages: row.organization_pages,
    };
  }

  apps(actor: CloudActor): Promise<SocialApp[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const rows = (
        await sql.query<{
          network: SocialNetwork;
          client_id: string;
          organization_pages: boolean;
        }>(
          "SELECT network,client_id,organization_pages FROM cloud_social_apps WHERE organization_id=$1",
          [actor.organizationId],
        )
      ).rows;
      return socialNetworks.map((network) => {
        const row = rows.find((entry) => entry.network === network);
        return {
          network,
          configured: Boolean(row),
          clientId: row?.client_id ?? null,
          organizationPages: row?.organization_pages ?? false,
          redirectUri: this.redirectUri(network),
        };
      });
    });
  }

  setApp(
    actor: CloudActor,
    network: SocialNetwork,
    input: {
      clientId: string;
      clientSecret: string;
      organizationPages: boolean;
    },
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const storage = await requireCredentialStorage(sql, this.cipher);
      await sql.query(
        `INSERT INTO cloud_social_apps (organization_id,network,client_id,secret,organization_pages,updated_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (organization_id,network) DO UPDATE SET client_id=$3,secret=$4,organization_pages=$5,updated_by=$6,updated_at=clock_timestamp()`,
        [
          actor.organizationId,
          network,
          input.clientId,
          storage.encrypt(
            Buffer.from(input.clientSecret, "utf8"),
            appContext(actor.organizationId, network),
          ),
          network === "linkedin" && input.organizationPages,
          actor.userId,
        ],
      );
    });
  }

  accounts(actor: CloudActor): Promise<SocialAccount[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<SocialAccount & Record<string, unknown>>(
          `SELECT a.id,a.network,a.name,a.external_id AS "externalId",u.name AS "connectedBy",
          to_char(a.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",a.error,
          to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
          FROM cloud_social_accounts a JOIN cloud_users u ON u.id=a.connected_by WHERE a.organization_id=$1 ORDER BY a.network,lower(a.name)`,
          [actor.organizationId],
        )
      ).rows;
    });
  }

  removeAccount(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const used = await sql.query(
        "SELECT 1 FROM cloud_product_channels WHERE organization_id=$1 AND account_id=$2 LIMIT 1",
        [actor.organizationId, id],
      );
      if (used.rows.length)
        throw new CloudError(
          409,
          "account_in_use",
          "Channels use this account. Move them to another account first.",
        );
      await sql.query(
        "DELETE FROM cloud_social_accounts WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }

  startConnect(actor: CloudActor, network: SocialNetwork): Promise<string> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const app = await this.app(sql, actor.organizationId, network);
      const state = randomBytes(32).toString("base64url");
      await sql.query(
        "DELETE FROM cloud_social_oauth_states WHERE expires_at<clock_timestamp()",
      );
      await sql.query(
        `INSERT INTO cloud_social_oauth_states (state_hash,organization_id,user_id,network,expires_at)
        VALUES ($1,$2,$3,$4,clock_timestamp()+$5*interval '1 minute')`,
        [
          hash(state),
          actor.organizationId,
          actor.userId,
          network,
          stateLifetimeMinutes,
        ],
      );
      return authorizeUrl(network, app, state);
    });
  }

  async completeConnect(
    actor: CloudActor,
    network: SocialNetwork,
    code: string,
    state: string,
  ): Promise<{ id: string }> {
    const app = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const claimed = await sql.query(
        "DELETE FROM cloud_social_oauth_states WHERE state_hash=$1 AND organization_id=$2 AND user_id=$3 AND network=$4 AND expires_at>clock_timestamp() RETURNING state_hash",
        [hash(state), actor.organizationId, actor.userId, network],
      );
      if (!claimed.rows.length)
        throw new CloudError(
          400,
          "social_state",
          "The sign-in link expired. Start connecting again.",
        );
      return this.app(sql, actor.organizationId, network);
    });
    const client = network === "linkedin" ? this.linkedin : this.reddit;
    let tokens: SocialTokens;
    let identity: { externalId: string; name: string };
    try {
      tokens = await client.exchange(app, code);
      identity = await client.identity(tokens.accessToken);
    } catch (error) {
      throw socialFailure(error);
    }
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const storage = await requireCredentialStorage(sql, this.cipher);
      const existing = (
        await sql.query<{ id: string }>(
          "SELECT id FROM cloud_social_accounts WHERE organization_id=$1 AND network=$2 AND external_id=$3",
          [actor.organizationId, network, identity.externalId],
        )
      ).rows[0];
      const id = existing?.id ?? randomUUID();
      const secret = storage.encrypt(
        Buffer.from(JSON.stringify(tokens), "utf8"),
        accountContext(actor.organizationId, id),
      );
      await sql.query(
        `INSERT INTO cloud_social_accounts (organization_id,id,network,external_id,name,secret,expires_at,connected_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (organization_id,id) DO UPDATE SET name=$5,secret=$6,expires_at=$7,connected_by=$8,error=NULL`,
        [
          actor.organizationId,
          id,
          network,
          identity.externalId,
          identity.name.slice(0, 200),
          secret,
          tokens.expiresAt ? new Date(tokens.expiresAt) : null,
          actor.userId,
        ],
      );
      return { id };
    });
  }

  async access(
    organizationId: string,
    accountId: string,
  ): Promise<SocialAccess> {
    const stored = await this.database.transaction(async (sql) => {
      const row = (
        await sql.query<{
          network: SocialNetwork;
          external_id: string;
          name: string;
          secret: Uint8Array;
        }>(
          "SELECT network,external_id,name,secret FROM cloud_social_accounts WHERE organization_id=$1 AND id=$2",
          [organizationId, accountId],
        )
      ).rows[0];
      if (!row)
        throw new CloudError(
          404,
          "account_unavailable",
          "The social account is unavailable.",
        );
      const storage = await requireCredentialStorage(sql, this.cipher);
      let tokens: SocialTokens;
      try {
        tokens = JSON.parse(
          storage
            .decrypt(
              Buffer.from(row.secret),
              accountContext(organizationId, accountId),
            )
            .toString("utf8"),
        ) as SocialTokens;
      } catch {
        throw new CloudError(
          503,
          "credential_storage",
          "The account sign-in cannot be unlocked. Reconnect it.",
        );
      }
      const app =
        tokens.expiresAt !== null &&
        tokens.expiresAt - Date.now() < refreshMarginMs
          ? await this.app(sql, organizationId, row.network)
          : null;
      return { row, tokens, app };
    });
    const { row, app } = stored;
    let { tokens } = stored;
    if (app) {
      if (!tokens.refreshToken)
        throw await this.markExpired(organizationId, accountId);
      try {
        const refreshed = await (
          row.network === "linkedin" ? this.linkedin : this.reddit
        ).refresh(app, tokens.refreshToken);
        tokens = {
          ...refreshed,
          refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
        };
      } catch (error) {
        if (
          error instanceof SocialApiError &&
          [400, 401].includes(error.status)
        )
          throw await this.markExpired(organizationId, accountId);
        throw socialFailure(error);
      }
      await this.database.transaction(async (sql) => {
        const storage = await requireCredentialStorage(sql, this.cipher);
        await sql.query(
          "UPDATE cloud_social_accounts SET secret=$3,expires_at=$4,error=NULL WHERE organization_id=$1 AND id=$2",
          [
            organizationId,
            accountId,
            storage.encrypt(
              Buffer.from(JSON.stringify(tokens), "utf8"),
              accountContext(organizationId, accountId),
            ),
            tokens.expiresAt ? new Date(tokens.expiresAt) : null,
          ],
        );
      });
    }
    return {
      network: row.network,
      externalId: row.external_id,
      name: row.name,
      accessToken: tokens.accessToken,
    };
  }

  private async markExpired(
    organizationId: string,
    accountId: string,
  ): Promise<CloudError> {
    const error = new CloudError(
      409,
      "social_reconnect",
      "The account sign-in expired. Reconnect it under Releases → Connections.",
    );
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_social_accounts SET error=$3 WHERE organization_id=$1 AND id=$2",
        [organizationId, accountId, error.message],
      ),
    );
    return error;
  }

  private async requireAdminAccess(
    actor: CloudActor,
    accountId: string,
  ): Promise<SocialAccess> {
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "admin"),
    );
    return this.access(actor.organizationId, accountId);
  }

  async targets(actor: CloudActor, accountId: string): Promise<SocialTarget[]> {
    const access = await this.requireAdminAccess(actor, accountId);
    if (access.network !== "linkedin")
      throw new CloudError(
        422,
        "account_network",
        "Choose a LinkedIn account.",
      );
    try {
      return await this.linkedin.targets(access.accessToken, {
        externalId: access.externalId,
        name: access.name,
      });
    } catch (error) {
      throw socialFailure(error);
    }
  }

  async flairs(
    actor: CloudActor,
    accountId: string,
    subreddit: string,
  ): Promise<SubredditFlair[]> {
    const access = await this.requireAdminAccess(actor, accountId);
    if (access.network !== "reddit")
      throw new CloudError(422, "account_network", "Choose a Reddit account.");
    try {
      return await this.reddit.flairs(access.accessToken, subreddit);
    } catch (error) {
      throw socialFailure(error);
    }
  }
}
