import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  imageMimeTypes,
  maximumMediaBytes,
  videoMimeTypes,
  type MediaRole,
  type ReleaseMedia,
  type VideoInput,
  type VisualInput,
} from "../../../lib/cloud-release-media-contract";
import { imageDimensions } from "../../../lib/media-dimensions";
import { CloudError, requireMembership } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import {
  byteRange,
  readChunks,
  streamChunks,
  writeChunks,
  type ChunkTable,
  type StoredFile,
} from "../chunked-files";

const mediaChunks: ChunkTable = {
  table: "cloud_release_media_chunks",
  owner: "media_id",
};
const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const mediaColumns = `m.id,m.product_id AS "productId",m.release_id AS "releaseId",m.kind,m.role,m.name,m.mime,m.byte_length AS "byteLength",
  m.width,m.height,m.duration_ms AS "durationMs",m.caption,m.alt_text AS "altText",m.source,m.recipe,${timestamp("m.created_at")} AS "createdAt"`;

export function mediaKind(mime: string): "image" | "video" {
  if ((imageMimeTypes as readonly string[]).includes(mime)) return "image";
  if ((videoMimeTypes as readonly string[]).includes(mime)) return "video";
  throw new CloudError(
    415,
    "media_type",
    "Upload a PNG, JPEG or WebP image, or an MP4, WebM or MOV video.",
  );
}

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export interface MediaOwner {
  productId: string;
  releaseId: string | null;
}

export type MediaFile = StoredFile;

export class CloudReleaseMedia {
  constructor(private readonly database: CloudDatabase) {}

  private async requireOwner(
    sql: CloudSql,
    organizationId: string,
    owner: MediaOwner,
  ): Promise<void> {
    const found = owner.releaseId
      ? await sql.query(
          "SELECT 1 FROM cloud_releases WHERE organization_id=$1 AND id=$2 AND product_id=$3 AND NOT archived",
          [organizationId, owner.releaseId, owner.productId],
        )
      : await sql.query(
          "SELECT 1 FROM cloud_products WHERE organization_id=$1 AND id=$2",
          [organizationId, owner.productId],
        );
    if (!found.rows.length)
      throw new CloudError(404, "not_found", "Release is unavailable.");
  }

  async store(
    organizationId: string,
    createdBy: string | null,
    owner: MediaOwner,
    file: {
      name: string;
      mime: string;
      role: MediaRole;
      source: ReleaseMedia["source"];
      caption?: string;
      recipe?: VisualInput | VideoInput | null;
      durationMs?: number | null;
    },
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<ReleaseMedia> {
    const kind = mediaKind(file.mime);
    const id = randomUUID();
    await this.database.transaction(async (sql) => {
      await this.requireOwner(sql, organizationId, owner);
      await sql.query(
        `INSERT INTO cloud_release_media (organization_id,id,product_id,release_id,kind,role,source,name,mime,caption,recipe,duration_ms,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          organizationId,
          id,
          owner.productId,
          owner.releaseId,
          kind,
          file.role,
          file.source,
          file.name.slice(0, 200),
          file.mime,
          (file.caption ?? "").slice(0, 300),
          file.recipe ? JSON.stringify(file.recipe) : null,
          file.durationMs ?? null,
          createdBy,
        ],
      );
    });
    try {
      const { bytes: offset, first } = await writeChunks(
        this.database,
        mediaChunks,
        organizationId,
        id,
        body,
        maximumMediaBytes,
        () =>
          new CloudError(
            413,
            "media_too_large",
            "Files must be 200 MB or smaller.",
          ),
      );
      if (!offset)
        throw new CloudError(422, "media_empty", "The file is empty.");
      const dimensions =
        kind === "image" && first ? imageDimensions(first) : null;
      if (kind === "image" && !dimensions)
        throw new CloudError(
          422,
          "media_invalid",
          "The image could not be read.",
        );
      return await this.database.transaction(async (sql) => {
        await sql.query(
          "UPDATE cloud_release_media SET state='ready',byte_length=$3,width=$4,height=$5 WHERE organization_id=$1 AND id=$2",
          [
            organizationId,
            id,
            offset,
            dimensions?.width ?? null,
            dimensions?.height ?? null,
          ],
        );
        return this.readRow(sql, organizationId, id);
      });
    } catch (error) {
      await this.database.transaction((sql) =>
        sql.query(
          "DELETE FROM cloud_release_media WHERE organization_id=$1 AND id=$2",
          [organizationId, id],
        ),
      );
      throw error;
    }
  }

  private async readRow(
    sql: CloudSql,
    organizationId: string,
    id: string,
  ): Promise<ReleaseMedia> {
    const media = (
      await sql.query<ReleaseMedia & Record<string, unknown>>(
        `SELECT ${mediaColumns} FROM cloud_release_media m WHERE m.organization_id=$1 AND m.id=$2 AND m.state='ready'`,
        [organizationId, id],
      )
    ).rows[0];
    if (!media)
      throw new CloudError(
        404,
        "media_unavailable",
        "The file is unavailable.",
      );
    return media;
  }

  async upload(
    actor: CloudActor,
    owner: MediaOwner,
    file: { name: string; mime: string; role: MediaRole; caption: string },
    body: ReadableStream<Uint8Array>,
  ): Promise<ReleaseMedia> {
    await this.database.transaction((sql) =>
      requireMembership(sql, actor, "releases.edit"),
    );
    return this.store(
      actor.organizationId,
      actor.userId,
      owner,
      { ...file, source: "upload" },
      body,
    );
  }

  list(actor: CloudActor, owner: MediaOwner): Promise<ReleaseMedia[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.view");
      return (
        await sql.query<ReleaseMedia & Record<string, unknown>>(
          `SELECT ${mediaColumns} FROM cloud_release_media m WHERE m.organization_id=$1 AND m.product_id=$2 AND m.state='ready'
          AND (m.release_id=$3 OR ($3::uuid IS NULL AND m.release_id IS NULL)) ORDER BY m.created_at DESC,m.id LIMIT 300`,
          [actor.organizationId, owner.productId, owner.releaseId],
        )
      ).rows;
    });
  }

  get(actor: CloudActor, id: string): Promise<ReleaseMedia> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.view");
      return this.readRow(sql, actor.organizationId, id);
    });
  }

  update(
    actor: CloudActor,
    id: string,
    input: { caption: string; altText: string },
  ): Promise<ReleaseMedia> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      await this.readRow(sql, actor.organizationId, id);
      await sql.query(
        "UPDATE cloud_release_media SET caption=$3,alt_text=$4 WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id, input.caption, input.altText],
      );
      return this.readRow(sql, actor.organizationId, id);
    });
  }

  remove(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      const used = await sql.query(
        "SELECT 1 FROM cloud_release_posts WHERE organization_id=$1 AND $2=ANY(media_ids) AND state IN ('publishing','published') LIMIT 1",
        [actor.organizationId, id],
      );
      if (used.rows.length)
        throw new CloudError(
          409,
          "media_published",
          "A published post uses this file.",
        );
      await sql.query(
        "UPDATE cloud_release_posts SET media_ids=array_remove(media_ids,$2),revision=revision+1 WHERE organization_id=$1 AND $2=ANY(media_ids)",
        [actor.organizationId, id],
      );
      await sql.query(
        "DELETE FROM cloud_release_media WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }

  private async file(
    organizationId: string,
    media: ReleaseMedia,
    range: string | null,
  ): Promise<MediaFile> {
    const total = media.byteLength;
    const { start, end } = byteRange(total, range);
    return {
      mime: media.mime,
      name: media.name,
      total,
      start,
      end,
      body: streamChunks(
        this.database,
        mediaChunks,
        organizationId,
        media.id,
        start,
        end,
      ),
    };
  }

  async read(
    actor: CloudActor,
    id: string,
    range: string | null,
  ): Promise<MediaFile> {
    const media = await this.get(actor, id);
    return this.file(actor.organizationId, media, range);
  }

  async bytes(
    organizationId: string,
    id: string,
  ): Promise<{ media: ReleaseMedia; bytes: Buffer }> {
    return this.database.transaction(async (sql) => {
      const media = await this.readRow(sql, organizationId, id);
      return {
        media,
        bytes: await readChunks(sql, mediaChunks, organizationId, id),
      };
    });
  }

  share(organizationId: string, id: string): Promise<string> {
    return this.database.transaction(async (sql) => {
      await this.readRow(sql, organizationId, id);
      const token = randomBytes(32).toString("base64url");
      await sql.query(
        "UPDATE cloud_release_media SET share_token_hash=$3 WHERE organization_id=$1 AND id=$2",
        [organizationId, id, hashToken(token)],
      );
      return token;
    });
  }

  async readShared(token: string, range: string | null): Promise<MediaFile> {
    const { organizationId, media } = await this.database.transaction(
      async (sql) => {
        const row = (
          await sql.query<{ organization_id: string; id: string }>(
            "SELECT organization_id,id FROM cloud_release_media WHERE share_token_hash=$1 AND state='ready'",
            [hashToken(token)],
          )
        ).rows[0];
        if (!row)
          throw new CloudError(404, "not_found", "The file is unavailable.");
        return {
          organizationId: row.organization_id,
          media: await this.readRow(sql, row.organization_id, row.id),
        };
      },
    );
    return this.file(organizationId, media, range);
  }
}
