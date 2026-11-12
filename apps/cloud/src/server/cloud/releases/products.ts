import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  ChannelInput,
  CloudChannel,
  CloudProduct,
  ProductInput,
} from "../../../lib/cloud-release-contract";
import type { SettingsCipher } from "../../settings-crypto";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
} from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";

const maximumProducts = 50;
const maximumChannels = 20;

export function webhookContext(organizationId: string, channelId: string) {
  return Buffer.from(
    JSON.stringify({
      kind: "cloud.release.webhook",
      organizationId,
      channelId,
    }),
  );
}

const productColumns = `p.id,p.revision,p.archived,p.definition,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  (SELECT count(*)::integer FROM cloud_product_channels c WHERE c.organization_id=p.organization_id AND c.product_id=p.id) AS "channelCount",
  (SELECT count(*)::integer FROM cloud_releases r WHERE r.organization_id=p.organization_id AND r.product_id=p.id AND NOT r.archived) AS "releaseCount"`;

type ProductRow = {
  id: string;
  revision: number;
  archived: boolean;
  definition: ProductInput;
  createdAt: string;
  channelCount: number;
  releaseCount: number;
};

function product(row: ProductRow): CloudProduct {
  const { definition, ...rest } = row;
  return { ...definition, ...rest };
}

export async function readProduct(
  sql: CloudSql,
  organizationId: string,
  id: string,
  lock = false,
): Promise<CloudProduct> {
  const row = (
    await sql.query<ProductRow & Record<string, unknown>>(
      `SELECT ${productColumns} FROM cloud_products p WHERE p.organization_id=$1 AND p.id=$2${lock ? " FOR UPDATE" : ""}`,
      [organizationId, id],
    )
  ).rows[0];
  if (!row) throw new CloudError(404, "not_found", "Product is unavailable.");
  return product(row);
}

type ChannelRow = {
  id: string;
  product_id: string;
  kind: CloudChannel["kind"];
  definition: Record<string, unknown>;
  account_id: string | null;
  account_name: string | null;
  position: number;
  revision: number;
};

function channel(row: ChannelRow): CloudChannel {
  const { host, ...definition } = row.definition as {
    host?: string;
  } & Record<string, unknown>;
  return {
    ...definition,
    ...(row.kind === "webhook"
      ? { webhookHost: host ?? "" }
      : { accountId: row.account_id }),
    kind: row.kind,
    id: row.id,
    productId: row.product_id,
    revision: row.revision,
    position: row.position,
    accountName: row.account_name,
  } as CloudChannel;
}

export const channelSelect = `SELECT c.id,c.product_id,c.kind,c.definition,c.account_id,a.name AS account_name,c.position,c.revision
  FROM cloud_product_channels c LEFT JOIN cloud_social_accounts a ON a.organization_id=c.organization_id AND a.id=c.account_id`;

export async function readChannels(
  sql: CloudSql,
  organizationId: string,
  productId: string,
): Promise<CloudChannel[]> {
  return (
    await sql.query<ChannelRow & Record<string, unknown>>(
      `${channelSelect} WHERE c.organization_id=$1 AND c.product_id=$2 ORDER BY c.position,c.id`,
      [organizationId, productId],
    )
  ).rows.map(channel);
}

async function requireLogo(
  sql: CloudSql,
  actor: CloudActor,
  productId: string,
  input: ProductInput,
): Promise<void> {
  if (!input.logoMediaId) return;
  const found = await sql.query(
    "SELECT 1 FROM cloud_release_media WHERE organization_id=$1 AND id=$2 AND product_id=$3 AND kind='image' AND state='ready'",
    [actor.organizationId, input.logoMediaId, productId],
  );
  if (!found.rows.length)
    throw new CloudError(422, "logo_unavailable", "Upload the logo again.");
}

async function requireTeams(
  sql: CloudSql,
  actor: CloudActor,
  teamIds: string[],
): Promise<void> {
  if (!teamIds.length) return;
  const found = await sql.query(
    "SELECT id FROM cloud_teams WHERE organization_id=$1 AND id=ANY($2::uuid[])",
    [actor.organizationId, teamIds],
  );
  if (found.rows.length !== new Set(teamIds).size)
    throw new CloudError(
      422,
      "team_unavailable",
      "A chosen team is unavailable.",
    );
}

function webhookHost(url: string): string {
  return new URL(url).host;
}

export class CloudProducts {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
  ) {}

  list(actor: CloudActor, archived = false): Promise<CloudProduct[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<ProductRow & Record<string, unknown>>(
          `SELECT ${productColumns} FROM cloud_products p WHERE p.organization_id=$1 AND p.archived=$2 ORDER BY lower(p.definition->>'name'),p.id`,
          [actor.organizationId, archived],
        )
      ).rows.map(product);
    });
  }

  get(
    actor: CloudActor,
    id: string,
  ): Promise<{ product: CloudProduct; channels: CloudChannel[] }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return {
        product: await readProduct(sql, actor.organizationId, id),
        channels: await readChannels(sql, actor.organizationId, id),
      };
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: ProductInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return command(
        sql,
        actor,
        key,
        { kind: "product.create", input },
        async () => {
          const count = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM cloud_products WHERE organization_id=$1",
              [actor.organizationId],
            )
          ).rows[0]!.count;
          if (count >= maximumProducts)
            throw new CloudError(
              409,
              "product_limit",
              `An organization holds up to ${maximumProducts} products.`,
            );
          if (input.logoMediaId)
            throw new CloudError(
              422,
              "logo_unavailable",
              "Add the logo after creating the product.",
            );
          await requireTeams(sql, actor, input.teamIds);
          const duplicate = await sql.query(
            "SELECT 1 FROM cloud_products WHERE organization_id=$1 AND key=$2",
            [actor.organizationId, input.key],
          );
          if (duplicate.rows.length)
            throw new CloudError(
              409,
              "product_key",
              "Another product uses this key.",
            );
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_products (organization_id,id,key,definition) VALUES ($1,$2,$3,$4)",
            [actor.organizationId, id, input.key, JSON.stringify(input)],
          );
          await recordEvent(sql, actor, "product.created", id, 1, {});
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: { revision: number; product: ProductInput },
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const current = await readProduct(sql, actor.organizationId, id, true);
      return command(
        sql,
        actor,
        key,
        { kind: "product.update", id, input },
        async () => {
          checkRevision(current.revision, input.revision);
          await requireTeams(sql, actor, input.product.teamIds);
          await requireLogo(sql, actor, id, input.product);
          const duplicate = await sql.query(
            "SELECT 1 FROM cloud_products WHERE organization_id=$1 AND key=$2 AND id<>$3",
            [actor.organizationId, input.product.key, id],
          );
          if (duplicate.rows.length)
            throw new CloudError(
              409,
              "product_key",
              "Another product uses this key.",
            );
          await sql.query(
            "UPDATE cloud_products SET key=$3,definition=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.product.key,
              JSON.stringify(input.product),
            ],
          );
          await recordEvent(
            sql,
            actor,
            "product.updated",
            id,
            current.revision + 1,
            {},
          );
          return { id };
        },
      );
    });
  }

  archive(
    actor: CloudActor,
    id: string,
    input: { revision: number; archived: boolean },
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const current = await readProduct(sql, actor.organizationId, id, true);
      checkRevision(current.revision, input.revision);
      await sql.query(
        "UPDATE cloud_products SET archived=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id, input.archived],
      );
    });
  }

  private async validateChannel(
    sql: CloudSql,
    actor: CloudActor,
    input: ChannelInput,
  ): Promise<void> {
    if (input.kind === "webhook") return;
    const account = (
      await sql.query<{ network: string }>(
        "SELECT network FROM cloud_social_accounts WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, input.accountId],
      )
    ).rows[0];
    if (account?.network !== input.kind)
      throw new CloudError(
        422,
        "account_unavailable",
        `Connect a ${input.kind === "linkedin" ? "LinkedIn" : "Reddit"} account for this channel.`,
      );
  }

  private async storeWebhook(
    sql: CloudSql,
    actor: CloudActor,
    id: string,
    url: string,
  ): Promise<Buffer> {
    const storage = await requireCredentialStorage(sql, this.cipher);
    return storage.encrypt(
      Buffer.from(url, "utf8"),
      webhookContext(actor.organizationId, id),
    );
  }

  private definition(input: ChannelInput): Record<string, unknown> {
    if (input.kind !== "webhook") {
      const { accountId: _, ...rest } = input;
      return rest;
    }
    const { url, ...rest } = input;
    return { ...rest, host: url ? webhookHost(url) : "" };
  }

  createChannel(
    actor: CloudActor,
    key: string,
    productId: string,
    input: ChannelInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      await readProduct(sql, actor.organizationId, productId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "channel.create", productId, input },
        async () => {
          const count = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM cloud_product_channels WHERE organization_id=$1 AND product_id=$2",
              [actor.organizationId, productId],
            )
          ).rows[0]!.count;
          if (count >= maximumChannels)
            throw new CloudError(
              409,
              "channel_limit",
              `A product holds up to ${maximumChannels} channels.`,
            );
          await this.validateChannel(sql, actor, input);
          if (input.kind === "webhook" && !input.url)
            throw new CloudError(422, "webhook_url", "Enter the webhook URL.");
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_product_channels (organization_id,id,product_id,kind,definition,account_id,webhook_secret,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              actor.organizationId,
              id,
              productId,
              input.kind,
              JSON.stringify(this.definition(input)),
              input.kind === "webhook" ? null : input.accountId,
              input.kind === "webhook"
                ? await this.storeWebhook(sql, actor, id, input.url!)
                : null,
              count,
            ],
          );
          return { id };
        },
      );
    });
  }

  updateChannel(
    actor: CloudActor,
    key: string,
    id: string,
    input: { revision: number; channel: ChannelInput },
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const current = (
        await sql.query<{
          kind: string;
          revision: number;
          definition: { host?: string };
        }>(
          "SELECT kind,revision,definition FROM cloud_product_channels WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!current)
        throw new CloudError(404, "not_found", "Channel is unavailable.");
      return command(
        sql,
        actor,
        key,
        { kind: "channel.update", id, input },
        async () => {
          checkRevision(current.revision, input.revision);
          if (current.kind !== input.channel.kind)
            throw new CloudError(
              422,
              "channel_kind",
              "A channel keeps its network.",
            );
          await this.validateChannel(sql, actor, input.channel);
          const definition = this.definition(input.channel);
          if (input.channel.kind === "webhook" && !input.channel.url)
            definition.host = current.definition.host ?? "";
          await sql.query(
            `UPDATE cloud_product_channels SET definition=$3,account_id=$4,webhook_secret=COALESCE($5,webhook_secret),revision=revision+1 WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              JSON.stringify(definition),
              input.channel.kind === "webhook" ? null : input.channel.accountId,
              input.channel.kind === "webhook" && input.channel.url
                ? await this.storeWebhook(sql, actor, id, input.channel.url)
                : null,
            ],
          );
          return { id };
        },
      );
    });
  }

  removeChannel(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const published = await sql.query(
        "SELECT 1 FROM cloud_release_posts WHERE organization_id=$1 AND channel_id=$2 AND state IN ('publishing','published') LIMIT 1",
        [actor.organizationId, id],
      );
      if (published.rows.length)
        throw new CloudError(
          409,
          "channel_published",
          "This channel has published posts. Disable it instead.",
        );
      await sql.query(
        "DELETE FROM cloud_product_channels WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }
}
