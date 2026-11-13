import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudChannel,
  ReleaseCaptureBrief,
} from "../../../lib/cloud-release-contract";
import type {
  MediaCapabilities,
  ReleaseMedia,
  VideoInput,
  VisualInput,
} from "../../../lib/cloud-release-media-contract";
import { releaseTitle } from "../../../lib/release-posts";
import { CloudError, command, requireMembership } from "../access";
import type { CloudChatStore } from "../ai/chat-store";
import type { CloudDatabase, CloudSql } from "../database";
import { readChannels } from "./products";
import type { CloudReleaseMedia } from "./release-media";
import { readPosts, readReleaseRow, touchRelease } from "./releases";
import type { CloudVideoComposer } from "./video-composer";
import { renderVisual, type VisualContext } from "./visual-renderer";

const captureLifetimeHours = 24;
const maximumCaptureUploads = 40;
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export interface ReleaseWriteInput {
  providerId: string;
  model: string;
  scope: "all" | "notes" | "posts";
  channelIds: string[];
  instructions: string;
}

function channelBrief(channel: CloudChannel): string {
  const rules = channel.rules;
  const target =
    channel.kind === "reddit"
      ? ` Subreddits: ${channel.subreddits.map((entry) => `r/${entry.name} (${entry.postType} post)`).join(", ")}.`
      : channel.kind === "linkedin"
        ? ` Posts as ${channel.authorName}.`
        : "";
  return `- "${channel.name}" (${channel.kind}, id ${channel.id}).${target} At most ${rules.maxLength} characters. Hashtags: ${rules.hashtags ? "yes" : "no"}. Emoji: ${rules.emoji}. Link: ${rules.includeLink ? "include the release link" : "no link"}. Media: ${rules.media}.${rules.tone ? ` Tone: ${rules.tone}.` : ""}${rules.instructions ? ` Instructions: ${rules.instructions}` : ""}`;
}

export class CloudReleaseStudio {
  constructor(
    private readonly database: CloudDatabase,
    private readonly media: CloudReleaseMedia,
    readonly composer: CloudVideoComposer,
    private readonly chat: CloudChatStore,
    private readonly origin: string,
    private readonly wake: () => void,
  ) {}

  async capabilities(): Promise<MediaCapabilities> {
    return { video: await this.composer.available() };
  }

  async visualContext(
    organizationId: string,
    releaseId: string,
    mediaId: string | null,
  ): Promise<VisualContext & { productId: string }> {
    const release = await this.database.transaction((sql) =>
      readReleaseRow(sql, organizationId, releaseId),
    );
    const product = release.productDefinition;
    const logo = product.logoMediaId
      ? await this.media.bytes(organizationId, product.logoMediaId)
      : null;
    const image = mediaId
      ? await this.media.bytes(organizationId, mediaId)
      : null;
    if (
      image &&
      (image.media.kind !== "image" ||
        image.media.productId !== release.productId)
    )
      throw new CloudError(
        422,
        "media_unavailable",
        "Choose an image of this product.",
      );
    return {
      productId: release.productId,
      product: {
        name: product.name,
        tagline: product.tagline,
        website: product.website,
        brand: product.brand,
      },
      version: release.version,
      logo: logo && { bytes: logo.bytes, mime: logo.media.mime },
      image: image && { bytes: image.bytes, mime: image.media.mime },
    };
  }

  async previewVisual(
    actor: CloudActor,
    releaseId: string,
    input: VisualInput,
  ): Promise<Buffer> {
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "releases.edit"),
    );
    return renderVisual(
      input,
      await this.visualContext(actor.organizationId, releaseId, input.mediaId),
    );
  }

  async saveVisual(
    organizationId: string,
    actorId: string,
    releaseId: string,
    input: VisualInput,
  ): Promise<ReleaseMedia> {
    const context = await this.visualContext(
      organizationId,
      releaseId,
      input.mediaId,
    );
    const bytes = await renderVisual(input, context);
    const media = await this.media.store(
      organizationId,
      actorId,
      { productId: context.productId, releaseId },
      {
        name: `${input.template}-${input.format}.png`,
        mime: "image/png",
        role: "visual",
        source: "template",
        caption: input.headline,
        recipe: input,
      },
      bytes,
    );
    await this.database.transaction((sql) =>
      touchRelease(sql, organizationId, releaseId),
    );
    return media;
  }

  async createVisual(
    actor: CloudActor,
    releaseId: string,
    input: VisualInput,
  ): Promise<ReleaseMedia> {
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "releases.edit"),
    );
    return this.saveVisual(
      actor.organizationId,
      actor.userId,
      releaseId,
      input,
    );
  }

  private async insertJob(
    sql: CloudSql,
    actor: CloudActor,
    releaseId: string,
    kind: "write" | "video" | "capture",
    input: unknown,
    state: "queued" | "waiting",
    detail: string,
  ): Promise<string> {
    const active = await sql.query(
      "SELECT 1 FROM cloud_release_jobs WHERE organization_id=$1 AND release_id=$2 AND kind=$3 AND state IN ('queued','running') LIMIT 1",
      [actor.organizationId, releaseId, kind],
    );
    if (active.rows.length && kind !== "capture")
      throw new CloudError(409, "job_active", "This step is already running.");
    const id = randomUUID();
    await sql.query(
      "INSERT INTO cloud_release_jobs (organization_id,id,release_id,kind,state,actor_id,input,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        actor.organizationId,
        id,
        releaseId,
        kind,
        state,
        actor.userId,
        JSON.stringify(input),
        detail,
      ],
    );
    await touchRelease(sql, actor.organizationId, releaseId);
    return id;
  }

  async queueVideo(
    actor: CloudActor,
    key: string,
    releaseId: string,
    input: VideoInput,
  ): Promise<{ id: string }> {
    if (!(await this.composer.available()))
      throw new CloudError(
        503,
        "video_unavailable",
        "Video composition needs ffmpeg on the Cloud server.",
      );
    const result = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      const release = await readReleaseRow(
        sql,
        actor.organizationId,
        releaseId,
      );
      const found = await sql.query(
        "SELECT id FROM cloud_release_media WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND product_id=$3 AND state='ready' AND (release_id IS NULL OR release_id=$4)",
        [
          actor.organizationId,
          input.clips.map((clip) => clip.mediaId),
          release.productId,
          releaseId,
        ],
      );
      if (
        found.rows.length !==
        new Set(input.clips.map((clip) => clip.mediaId)).size
      )
        throw new CloudError(
          422,
          "media_unavailable",
          "A clip is unavailable.",
        );
      return command(
        sql,
        actor,
        key,
        { kind: "release.video", releaseId, input },
        async () => ({
          id: await this.insertJob(
            sql,
            actor,
            releaseId,
            "video",
            input,
            "queued",
            "Waiting to render",
          ),
        }),
      );
    });
    this.wake();
    return result;
  }

  startCapture(
    actor: CloudActor,
    releaseId: string,
    input: { shots: string[] },
  ): Promise<ReleaseCaptureBrief> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      const release = await readReleaseRow(
        sql,
        actor.organizationId,
        releaseId,
      );
      const product = release.productDefinition;
      const jobId = await this.insertJob(
        sql,
        actor,
        releaseId,
        "capture",
        input,
        "waiting",
        "Waiting for captures",
      );
      const token = randomBytes(32).toString("base64url");
      const expires = (
        await sql.query<{ expiresAt: string }>(
          `INSERT INTO cloud_release_capture_tokens (token_hash,organization_id,release_id,job_id,created_by,expires_at)
          VALUES ($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 hour')
          RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`,
          [
            hashToken(token),
            actor.organizationId,
            releaseId,
            jobId,
            actor.userId,
            captureLifetimeHours,
          ],
        )
      ).rows[0]!;
      const uploadUrl = `${this.origin}/api/v1/release-capture/${token}`;
      const title = releaseTitle(product, release);
      const prompt = [
        `Capture release media for ${title}.`,
        "",
        "Run the product in sandbox mode with realistic mock data. Never use production data, real customer names or secrets.",
        product.captureBrief ? `How to run it:\n${product.captureBrief}` : "",
        "",
        "Capture each of these shots as a PNG screenshot at 1920×1080 or larger. Record a short MP4 screen recording when a shot shows motion:",
        ...input.shots.map((shot, index) => `${index + 1}. ${shot}`),
        "",
        "Upload every file as soon as it is ready:",
        "```sh",
        `curl --fail -X POST -H "Content-Type: image/png" --data-binary @shot.png "${uploadUrl}?name=shot.png&caption=<what the shot shows>"`,
        "```",
        "Use Content-Type video/mp4 for recordings. URL-encode the caption. The upload link expires in 24 hours.",
      ]
        .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
        .join("\n");
      return { prompt, uploadUrl, expiresAt: expires.expiresAt };
    });
  }

  async receiveCapture(
    token: string,
    file: { name: string; caption: string; mime: string },
    body: ReadableStream<Uint8Array>,
  ): Promise<{ id: string }> {
    const grant = await this.database.transaction(async (sql) => {
      const row = (
        await sql.query<{
          organization_id: string;
          release_id: string;
          job_id: string;
          created_by: string;
          uploads: number;
        }>(
          "SELECT organization_id,release_id,job_id,created_by,uploads FROM cloud_release_capture_tokens WHERE token_hash=$1 AND expires_at>clock_timestamp() FOR UPDATE",
          [hashToken(token)],
        )
      ).rows[0];
      if (!row)
        throw new CloudError(404, "not_found", "The upload link expired.");
      if (row.uploads >= maximumCaptureUploads)
        throw new CloudError(
          429,
          "capture_limit",
          `An upload link accepts up to ${maximumCaptureUploads} files.`,
        );
      await sql.query(
        "UPDATE cloud_release_capture_tokens SET uploads=uploads+1 WHERE token_hash=$1",
        [hashToken(token)],
      );
      const release = await readReleaseRow(
        sql,
        row.organization_id,
        row.release_id,
      );
      return { ...row, productId: release.productId };
    });
    const media = await this.media.store(
      grant.organization_id,
      grant.created_by,
      { productId: grant.productId, releaseId: grant.release_id },
      {
        name: file.name,
        mime: file.mime,
        role: file.mime.startsWith("video/") ? "recording" : "screenshot",
        source: "capture",
        caption: file.caption,
      },
      body,
    );
    await this.database.transaction(async (sql) => {
      await sql.query(
        `UPDATE cloud_release_jobs SET state='succeeded',detail=$3,finished_at=COALESCE(finished_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2`,
        [
          grant.organization_id,
          grant.job_id,
          `${grant.uploads + 1} ${grant.uploads === 0 ? "file" : "files"} received`,
        ],
      );
      await touchRelease(sql, grant.organization_id, grant.release_id);
    });
    return { id: media.id };
  }

  async startWrite(
    actor: CloudActor,
    key: string,
    releaseId: string,
    input: ReleaseWriteInput,
  ): Promise<{ id: string }> {
    const context = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      const release = await readReleaseRow(
        sql,
        actor.organizationId,
        releaseId,
      );
      if (release.archived)
        throw new CloudError(
          409,
          "release_archived",
          "Restore the release first.",
        );
      const channels = (
        await readChannels(sql, actor.organizationId, release.productId)
      ).filter(
        (channel) =>
          channel.enabled &&
          (!input.channelIds.length || input.channelIds.includes(channel.id)),
      );
      if (input.channelIds.length && !channels.length)
        throw new CloudError(
          400,
          "channel_unavailable",
          "Enable the channel first.",
        );
      const posts = (
        await readPosts(sql, actor.organizationId, releaseId)
      ).filter((post) =>
        channels.some((channel) => channel.id === post.channelId),
      );
      const items = (
        await sql.query<{ identifier: string; title: string }>(
          `SELECT i.identifier,i.title FROM cloud_release_items x JOIN cloud_issues i ON i.organization_id=x.organization_id AND i.id=x.issue_id
          WHERE x.organization_id=$1 AND x.release_id=$2 AND x.included ORDER BY i.updated_at DESC LIMIT 80`,
          [actor.organizationId, releaseId],
        )
      ).rows;
      const media = (
        await sql.query<{
          id: string;
          role: string;
          caption: string;
          width: number | null;
          height: number | null;
          kind: string;
        }>(
          "SELECT id,role,caption,width,height,kind FROM cloud_release_media WHERE organization_id=$1 AND release_id=$2 AND state='ready' ORDER BY created_at LIMIT 40",
          [actor.organizationId, releaseId],
        )
      ).rows;
      return { release, channels, posts, items, media };
    });
    const { release, channels, posts, items, media } = context;
    const product = release.productDefinition;
    const writePosts = input.scope !== "notes";
    if (writePosts && !channels.length)
      throw new CloudError(
        409,
        "channels_required",
        "Add a channel to this product first.",
      );
    const prompt = [
      `Write the launch content for ${releaseTitle(product, release)} (release ID ${release.id}).`,
      "",
      `Product: ${product.name}${product.tagline ? ` — ${product.tagline}` : ""}.`,
      product.description ? `About: ${product.description}` : "",
      product.audience ? `Audience: ${product.audience}` : "",
      product.voice ? `Voice and style rules:\n${product.voice}` : "",
      product.hashtags.length
        ? `Hashtags: ${product.hashtags.map((tag) => `#${tag}`).join(" ")}`
        : "",
      product.callToAction ? `Call to action: ${product.callToAction}` : "",
      product.website ? `Website: ${product.website}` : "",
      "",
      items.length
        ? `Shipped work:\n${items.map((item) => `- ${item.identifier}: ${item.title}`).join("\n")}`
        : "No issues are linked; read the existing notes with get_release.",
      media.length
        ? `Media you may attach (ID, role, size, caption):\n${media.map((entry) => `- ${entry.id} ${entry.role} ${entry.width ?? "?"}×${entry.height ?? "?"} ${entry.caption}`).join("\n")}`
        : "",
      writePosts ? `Channels:\n${channels.map(channelBrief).join("\n")}` : "",
      "",
      input.scope !== "posts"
        ? "Call propose_release_notes once: a one-sentence summary, customer-facing notes in Markdown grouped by theme, and 3–6 highlights."
        : "",
      writePosts
        ? `Call propose_release_post once for each channel (${posts.length} in total), following its rules. Write natively for each network; never paste the same text twice. For Reddit, write an informative, non-promotional title and body.`
        : "",
      writePosts
        ? "Call propose_release_visual up to three times for branded visuals that match the channels' media formats, and attach each to the channels that should show it."
        : "",
      input.instructions
        ? `Additional instructions: ${input.instructions}`
        : "",
      "Nobody can answer questions, so do not call ask_user. Your proposals are applied automatically.",
    ]
      .filter(Boolean)
      .join("\n");
    const submission = await this.chat.startHiddenChat(actor, key, {
      owner: { releaseId },
      providerId: input.providerId,
      model: input.model,
      prompt,
      context: [],
    });
    const id = await this.database.transaction(async (sql) => {
      const existing = (
        await sql.query<{ id: string }>(
          "SELECT id FROM cloud_release_jobs WHERE organization_id=$1 AND chat_id=$2",
          [actor.organizationId, submission.chatId],
        )
      ).rows[0];
      if (existing) return existing.id;
      const jobId = await this.insertJob(
        sql,
        actor,
        releaseId,
        "write",
        input,
        "waiting",
        "Agent is writing",
      );
      await sql.query(
        "UPDATE cloud_release_jobs SET chat_id=$3,turn_id=$4 WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, jobId, submission.chatId, submission.turnId],
      );
      return jobId;
    });
    return { id };
  }
}
