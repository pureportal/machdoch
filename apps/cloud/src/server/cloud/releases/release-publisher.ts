import type {
  ChannelInput,
  ProductInput,
  ReleaseDelivery,
} from "../../../lib/cloud-release-contract";
import type { ReleaseMedia } from "../../../lib/cloud-release-media-contract";
import {
  composePost,
  discordContentLimit,
  linkedInCommentary,
  releaseTitle,
} from "../../../lib/release-posts";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, isCloudError } from "../access";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase } from "../database";
import { webhookContext } from "./products";
import type { CloudReleaseMedia } from "./release-media";
import {
  canPublish,
  readReleaseRow,
  touchRelease,
  type PublishRights,
} from "./releases";
import { socialFailure, type CloudSocial } from "./social-accounts";

const webhookTimeoutMs = 15_000;

interface ClaimedPost {
  id: string;
  releaseId: string;
  channelId: string;
  title: string;
  body: string;
  mediaIds: string[];
  link: string | null;
  publisherId: string | null;
}

interface ChannelRecord {
  kind: ChannelInput["kind"];
  definition: ChannelInput;
  accountId: string | null;
  webhookSecret: Uint8Array | null;
}

interface PublishContext {
  organizationId: string;
  post: ClaimedPost;
  channel: ChannelRecord;
  product: ProductInput;
  release: { id: string; version: string; name: string; summary: string };
  text: string;
  title: string;
  media: { media: ReleaseMedia; bytes: Buffer }[];
  delivered: ReleaseDelivery[];
}

type Outcome = {
  target: string;
  externalId?: string;
  url?: string;
  error?: string;
};

export class CloudReleasePublisher {
  constructor(
    private readonly database: CloudDatabase,
    private readonly social: CloudSocial,
    private readonly media: CloudReleaseMedia,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
    private readonly transport: typeof fetch,
  ) {}

  async due(limit: number): Promise<{ organizationId: string; id: string }[]> {
    return this.database.transaction(async (sql) => {
      await sql.query(
        `UPDATE cloud_release_posts SET state='failed',error='Publishing was interrupted. Check the network, then retry.',revision=revision+1
        WHERE state='publishing' AND scheduled_at<clock_timestamp()-interval '15 minutes'`,
      );
      return (
        await sql.query<{ organizationId: string; id: string }>(
          `SELECT organization_id AS "organizationId",id FROM cloud_release_posts WHERE state='scheduled' AND scheduled_at<=clock_timestamp()
          ORDER BY scheduled_at,id LIMIT ${limit}`,
        )
      ).rows;
    });
  }

  async publish(organizationId: string, postId: string): Promise<void> {
    const claimed = await this.claim(organizationId, postId);
    if (!claimed) return;
    let outcomes: Outcome[];
    try {
      outcomes = await this.deliver(claimed);
    } catch (error) {
      const failure = isCloudError(error) ? error : socialFailure(error);
      outcomes = [{ target: claimed.channel.kind, error: failure.message }];
    }
    await this.settle(claimed, outcomes);
  }

  private async claim(
    organizationId: string,
    postId: string,
  ): Promise<PublishContext | null> {
    const context = await this.database.transaction(async (sql) => {
      const post = (
        await sql.query<ClaimedPost & Record<string, unknown>>(
          `UPDATE cloud_release_posts SET state='publishing',error=NULL,revision=revision+1
          WHERE organization_id=$1 AND id=$2 AND state='scheduled' AND scheduled_at<=clock_timestamp()
          RETURNING id,release_id AS "releaseId",channel_id AS "channelId",title,body,media_ids AS "mediaIds",link,publisher_id AS "publisherId"`,
          [organizationId, postId],
        )
      ).rows[0];
      if (!post) return null;
      const channel = (
        await sql.query<ChannelRecord & Record<string, unknown>>(
          `SELECT kind,definition,account_id AS "accountId",webhook_secret AS "webhookSecret" FROM cloud_product_channels WHERE organization_id=$1 AND id=$2`,
          [organizationId, post.channelId],
        )
      ).rows[0]!;
      const release = await readReleaseRow(sql, organizationId, post.releaseId);
      const role = post.publisherId
        ? (
            await sql.query<PublishRights>(
              `SELECT cloud_member_can($1,$2,'releases.manage') AS manage,cloud_member_can($1,$2,'releases.edit') AS edit
              FROM cloud_users u WHERE u.id=$2 AND NOT u.disabled`,
              [organizationId, post.publisherId],
            )
          ).rows[0]
        : undefined;
      const delivered = (
        await sql.query<ReleaseDelivery & Record<string, unknown>>(
          'SELECT target,state,url,error,NULL AS "completedAt" FROM cloud_release_deliveries WHERE organization_id=$1 AND post_id=$2',
          [organizationId, postId],
        )
      ).rows;
      return { post, channel, release, role, delivered };
    });
    if (!context) return null;
    const { post, channel, release, role, delivered } = context;
    const product = release.productDefinition;
    const base: PublishContext = {
      organizationId,
      post,
      channel,
      product,
      release,
      text: "",
      title: "",
      media: [],
      delivered,
    };
    if (!role || !canPublish(role, product)) {
      await this.settle(base, [
        {
          target: channel.kind,
          error: "The publisher's access ended. Publish it again.",
        },
      ]);
      return null;
    }
    const composed = composePost(
      channel.kind,
      channel.definition.rules,
      post,
      product,
      releaseTitle(product, release),
    );
    const media = [];
    for (const id of post.mediaIds)
      media.push(await this.media.bytes(organizationId, id));
    return { ...base, text: composed.text, title: composed.title, media };
  }

  private async deliver(context: PublishContext): Promise<Outcome[]> {
    const { channel } = context;
    if (channel.definition.kind === "linkedin")
      return [await this.linkedIn(context, channel.definition)];
    if (channel.definition.kind === "reddit")
      return this.reddit(context, channel.definition);
    return [await this.webhook(context, channel.definition)];
  }

  private async linkedIn(
    context: PublishContext,
    definition: Extract<ChannelInput, { kind: "linkedin" }>,
  ): Promise<Outcome> {
    if (context.delivered.some((entry) => entry.state === "published"))
      return { target: "linkedin" };
    const access = await this.social.access(
      context.organizationId,
      context.channel.accountId!,
    );
    const client = this.social.linkedin;
    try {
      const video = context.media.find((entry) => entry.media.kind === "video");
      const images = context.media.filter(
        (entry) => entry.media.kind === "image",
      );
      let media: Parameters<typeof client.createPost>[1]["media"] = {
        kind: "none",
      };
      if (video) {
        media = {
          kind: "single",
          id: await client.uploadVideo(
            access.accessToken,
            definition.authorUrn,
            video.bytes,
          ),
          title: context.title,
          altText: "",
        };
      } else if (images.length === 1) {
        media = {
          kind: "single",
          id: await client.uploadImage(
            access.accessToken,
            definition.authorUrn,
            images[0]!.bytes,
          ),
          title: context.title,
          altText: images[0]!.media.altText || images[0]!.media.caption,
        };
      } else if (images.length > 1) {
        const uploaded = [];
        for (const image of images)
          uploaded.push({
            id: await client.uploadImage(
              access.accessToken,
              definition.authorUrn,
              image.bytes,
            ),
            altText: image.media.altText || image.media.caption,
          });
        media = { kind: "multi", images: uploaded };
      }
      const result = await client.createPost(access.accessToken, {
        author: definition.authorUrn,
        commentary: linkedInCommentary(context.text),
        media,
      });
      return { target: "linkedin", externalId: result.id, url: result.url };
    } catch (error) {
      return { target: "linkedin", error: socialFailure(error).message };
    }
  }

  private async reddit(
    context: PublishContext,
    definition: Extract<ChannelInput, { kind: "reddit" }>,
  ): Promise<Outcome[]> {
    const access = await this.social.access(
      context.organizationId,
      context.channel.accountId!,
    );
    const client = this.social.reddit;
    const image = context.media.find((entry) => entry.media.kind === "image");
    let imageUrl: string | null = null;
    const outcomes: Outcome[] = [];
    for (const subreddit of definition.subreddits) {
      const target = `r/${subreddit.name}`;
      if (
        context.delivered.some(
          (entry) => entry.target === target && entry.state === "published",
        )
      ) {
        outcomes.push({ target });
        continue;
      }
      try {
        const link = context.post.link ?? context.product.website;
        if (subreddit.postType === "image" && !image)
          throw new CloudError(
            422,
            "media_required",
            "Attach an image for this subreddit.",
          );
        if (subreddit.postType === "link" && !link)
          throw new CloudError(
            422,
            "link_required",
            "Add a link for this subreddit.",
          );
        if (subreddit.postType === "image" && !imageUrl)
          imageUrl = await client.uploadImage(
            access.accessToken,
            image!.bytes,
            image!.media.name,
            image!.media.mime,
          );
        const result = await client.submit(access.accessToken, {
          subreddit: subreddit.name,
          kind: subreddit.postType === "text" ? "self" : subreddit.postType,
          title: context.title,
          text: context.text,
          url: subreddit.postType === "image" ? imageUrl! : link!,
          flairId: subreddit.flairId,
          flairText: subreddit.flairText,
        });
        outcomes.push({ target, externalId: result.id, url: result.url });
      } catch (error) {
        outcomes.push({
          target,
          error: (isCloudError(error) ? error : socialFailure(error)).message,
        });
      }
    }
    return outcomes;
  }

  private async webhook(
    context: PublishContext,
    definition: Extract<ChannelInput, { kind: "webhook" }>,
  ): Promise<Outcome> {
    const url = await this.database.transaction(async (sql) => {
      const storage = await requireCredentialStorage(sql, this.cipher);
      return storage
        .decrypt(
          Buffer.from(context.channel.webhookSecret!),
          webhookContext(context.organizationId, context.post.channelId),
        )
        .toString("utf8");
    });
    const media = [];
    for (const entry of context.media)
      media.push({
        url: `${this.origin}/api/v1/release-media/public/${await this.media.share(context.organizationId, entry.media.id)}`,
        mime: entry.media.mime,
        caption: entry.media.caption,
      });
    const title = releaseTitle(context.product, context.release);
    const body =
      definition.format === "slack"
        ? {
            text: `*${title}*\n${context.text}${media.map((entry) => `\n${entry.url}`).join("")}`,
          }
        : definition.format === "discord"
          ? {
              content: context.text.slice(0, discordContentLimit),
              embeds: media
                .filter((entry) => entry.mime.startsWith("image/"))
                .slice(0, 4)
                .map((entry) => ({ title, image: { url: entry.url } })),
            }
          : {
              product: {
                name: context.product.name,
                key: context.product.key,
                website: context.product.website,
              },
              release: {
                id: context.release.id,
                version: context.release.version,
                name: context.release.name,
                summary: context.release.summary,
              },
              post: { title: context.title, text: context.text },
              media,
            };
    try {
      const response = await this.transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "machdoch-cloud-releases",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(webhookTimeoutMs),
      });
      if (!response.ok)
        return {
          target: "webhook",
          error: `The webhook responded with status ${response.status}.`,
        };
      return { target: "webhook" };
    } catch {
      return {
        target: "webhook",
        error: "The webhook address could not be reached.",
      };
    }
  }

  private async settle(
    context: PublishContext,
    outcomes: Outcome[],
  ): Promise<void> {
    const failed = outcomes.filter((outcome) => outcome.error);
    await this.database.transaction(async (sql) => {
      for (const outcome of outcomes)
        await sql.query(
          `INSERT INTO cloud_release_deliveries (organization_id,post_id,target,state,external_id,url,error,attempts,completed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,1,CASE WHEN $4='published' THEN clock_timestamp() END)
          ON CONFLICT (organization_id,post_id,target) DO UPDATE SET
            state=CASE WHEN cloud_release_deliveries.state='published' THEN 'published' ELSE excluded.state END,
            external_id=COALESCE(excluded.external_id,cloud_release_deliveries.external_id),
            url=COALESCE(excluded.url,cloud_release_deliveries.url),
            error=CASE WHEN cloud_release_deliveries.state='published' THEN NULL ELSE excluded.error END,
            attempts=cloud_release_deliveries.attempts+1,
            completed_at=COALESCE(cloud_release_deliveries.completed_at,excluded.completed_at)`,
          [
            context.organizationId,
            context.post.id,
            outcome.target,
            outcome.error ? "failed" : "published",
            outcome.externalId ?? null,
            outcome.url ?? null,
            outcome.error?.slice(0, 500) ?? null,
          ],
        );
      await sql.query(
        `UPDATE cloud_release_posts SET state=$3,error=$4,published_at=CASE WHEN $3='published' THEN clock_timestamp() ELSE published_at END,revision=revision+1
        WHERE organization_id=$1 AND id=$2`,
        [
          context.organizationId,
          context.post.id,
          failed.length ? "failed" : "published",
          failed.length
            ? failed
                .map((outcome) =>
                  outcomes.length > 1
                    ? `${outcome.target}: ${outcome.error}`
                    : outcome.error,
                )
                .join(" · ")
                .slice(0, 500)
            : null,
        ],
      );
      await touchRelease(sql, context.organizationId, context.post.releaseId);
    });
  }
}
