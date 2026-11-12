import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  attachmentKind,
  attachmentUrl,
  maximumAttachmentBytes,
  maximumChatAttachments,
  type AttachmentSource,
  type CloudAttachment,
} from "../../../lib/cloud-attachment-contract";
import { imageDimensions } from "../../../lib/media-dimensions";
import { CloudError, requireMembership, requireTeam } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import {
  byteRange,
  readChunks,
  streamChunks,
  writeChunks,
  type ChunkTable,
  type StoredFile,
} from "../chunked-files";

const attachmentChunks: ChunkTable = {
  table: "cloud_attachment_chunks",
  owner: "attachment_id",
};
const uploadLinkHours = 24;
const uploadLinkLimit = 50;
const pendingRetentionHours = 24;

const columns = `a.id,a.issue_id AS "issueId",a.chat_id AS "chatId",a.turn_id AS "turnId",a.name,a.mime,a.kind,a.byte_length AS "byteLength",a.width,a.height,a.source,
  a.created_by AS "createdById",u.name AS "createdByName",to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;
const from = `cloud_attachments a LEFT JOIN cloud_users u ON u.id=a.created_by`;

interface AttachmentRow extends Record<string, unknown> {
  id: string;
  issueId: string | null;
  chatId: string | null;
  turnId: string | null;
  name: string;
  mime: string;
  kind: CloudAttachment["kind"];
  byteLength: number;
  width: number | null;
  height: number | null;
  source: AttachmentSource;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ChatAttachment extends CloudAttachment {
  turnId: string | null;
}

export interface AttachmentTarget {
  issueId?: string;
  chatId?: string;
  turnId?: string;
}

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function present(row: AttachmentRow): ChatAttachment {
  return {
    id: row.id,
    issueId: row.issueId,
    turnId: row.turnId,
    name: row.name,
    mime: row.mime,
    kind: row.kind,
    byteLength: row.byteLength,
    width: row.width,
    height: row.height,
    source: row.source,
    createdBy:
      row.createdById && row.createdByName
        ? { id: row.createdById, name: row.createdByName }
        : null,
    createdAt: row.createdAt,
    url: attachmentUrl(row.id),
  };
}

function requireKind(mime: string): CloudAttachment["kind"] {
  const kind = attachmentKind(mime);
  if (!kind)
    throw new CloudError(
      415,
      "attachment_type",
      "Attach an image (PNG, JPEG, WebP, GIF), a video (MP4, WebM, MOV), a text, Markdown, CSV or JSON document, a PDF or a ZIP file.",
    );
  return kind;
}

export async function requireIssueAccess(
  sql: CloudSql,
  actor: CloudActor,
  issueId: string,
  write: boolean,
): Promise<void> {
  if (write) await requireMembership(sql, actor, "write");
  const issue = (
    await sql.query<{ team_id: string }>(
      "SELECT team_id FROM cloud_issues WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, issueId],
    )
  ).rows[0];
  if (!issue) throw new CloudError(404, "not_found", "Issue is unavailable.");
  await requireTeam(sql, actor, issue.team_id);
}

export class CloudAttachments {
  constructor(private readonly database: CloudDatabase) {}

  private async row(
    sql: CloudSql,
    organizationId: string,
    id: string,
  ): Promise<AttachmentRow> {
    const row = (
      await sql.query<AttachmentRow>(
        `SELECT ${columns} FROM ${from} WHERE a.organization_id=$1 AND a.id=$2 AND a.state='ready'`,
        [organizationId, id],
      )
    ).rows[0];
    if (!row)
      throw new CloudError(
        404,
        "attachment_unavailable",
        "The file is unavailable.",
      );
    return row;
  }

  private async accessible(
    sql: CloudSql,
    actor: CloudActor,
    id: string,
    write = false,
  ): Promise<AttachmentRow> {
    await requireMembership(sql, actor, write ? "write" : "read");
    const row = await this.row(sql, actor.organizationId, id);
    if (row.issueId) {
      await requireIssueAccess(sql, actor, row.issueId, write);
      return row;
    }
    const owner = row.chatId
      ? (
          await sql.query<{ user_id: string }>(
            "SELECT user_id FROM cloud_chats WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, row.chatId],
          )
        ).rows[0]?.user_id
      : row.createdById;
    if (owner !== actor.userId)
      throw new CloudError(
        404,
        "attachment_unavailable",
        "The file is unavailable.",
      );
    return row;
  }

  async store(
    organizationId: string,
    createdBy: string | null,
    target: AttachmentTarget,
    file: { name: string; mime: string; source: AttachmentSource },
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<ChatAttachment> {
    const kind = requireKind(file.mime);
    const name = file.name.trim().slice(0, 200) || "file";
    const id = randomUUID();
    await this.database.transaction((sql) =>
      sql.query(
        `INSERT INTO cloud_attachments (organization_id,id,issue_id,chat_id,turn_id,name,mime,kind,source,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          organizationId,
          id,
          target.issueId ?? null,
          target.chatId ?? null,
          target.turnId ?? null,
          name,
          file.mime,
          kind,
          file.source,
          createdBy,
        ],
      ),
    );
    try {
      const { bytes, first } = await writeChunks(
        this.database,
        attachmentChunks,
        organizationId,
        id,
        body,
        maximumAttachmentBytes,
        () =>
          new CloudError(
            413,
            "attachment_too_large",
            "Files must be 50 MB or smaller.",
          ),
      );
      if (!bytes)
        throw new CloudError(422, "attachment_empty", "The file is empty.");
      const dimensions =
        kind === "image" && first ? imageDimensions(first) : null;
      if (kind === "image" && !dimensions)
        throw new CloudError(
          422,
          "attachment_invalid",
          "The image could not be read.",
        );
      return await this.database.transaction(async (sql) => {
        await sql.query(
          "UPDATE cloud_attachments SET state='ready',byte_length=$3,width=$4,height=$5 WHERE organization_id=$1 AND id=$2",
          [
            organizationId,
            id,
            bytes,
            dimensions?.width ?? null,
            dimensions?.height ?? null,
          ],
        );
        return present(await this.row(sql, organizationId, id));
      });
    } catch (error) {
      await this.database.transaction((sql) =>
        sql.query(
          "DELETE FROM cloud_attachments WHERE organization_id=$1 AND id=$2",
          [organizationId, id],
        ),
      );
      throw error;
    }
  }

  async upload(
    actor: CloudActor,
    issueId: string | null,
    file: { name: string; mime: string },
    body: ReadableStream<Uint8Array>,
  ): Promise<CloudAttachment> {
    await this.database.transaction(async (sql) => {
      if (issueId) await requireIssueAccess(sql, actor, issueId, true);
      else {
        await requireMembership(sql, actor, "write");
        await sql.query(
          `DELETE FROM cloud_attachments WHERE organization_id=$1 AND created_by=$2 AND issue_id IS NULL AND chat_id IS NULL
          AND created_at<clock_timestamp()-$3*interval '1 hour'`,
          [actor.organizationId, actor.userId, pendingRetentionHours],
        );
      }
    });
    return this.store(
      actor.organizationId,
      actor.userId,
      issueId ? { issueId } : {},
      { ...file, source: "upload" },
      body,
    );
  }

  list(actor: CloudActor, issueId: string): Promise<CloudAttachment[]> {
    return this.database.transaction(async (sql) => {
      await requireIssueAccess(sql, actor, issueId, false);
      return (
        await sql.query<AttachmentRow>(
          `SELECT ${columns} FROM ${from} WHERE a.organization_id=$1 AND a.issue_id=$2 AND a.state='ready' ORDER BY a.created_at,a.id LIMIT 500`,
          [actor.organizationId, issueId],
        )
      ).rows.map(present);
    });
  }

  get(actor: CloudActor, id: string): Promise<ChatAttachment> {
    return this.database.transaction(async (sql) =>
      present(await this.accessible(sql, actor, id)),
    );
  }

  async read(
    actor: CloudActor,
    id: string,
    range: string | null,
  ): Promise<StoredFile> {
    const attachment = await this.get(actor, id);
    const { start, end } = byteRange(attachment.byteLength, range);
    return {
      mime: attachment.mime,
      name: attachment.name,
      total: attachment.byteLength,
      start,
      end,
      body: streamChunks(
        this.database,
        attachmentChunks,
        actor.organizationId,
        id,
        start,
        end,
      ),
    };
  }

  async bytes(
    actor: CloudActor,
    id: string,
  ): Promise<{ attachment: ChatAttachment; bytes: Buffer }> {
    return this.database.transaction(async (sql) => {
      const row = await this.accessible(sql, actor, id);
      return {
        attachment: present(row),
        bytes: await readChunks(
          sql,
          attachmentChunks,
          actor.organizationId,
          id,
        ),
      };
    });
  }

  remove(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await this.accessible(sql, actor, id, true);
      await sql.query(
        "DELETE FROM cloud_attachments WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }

  async pending(
    sql: CloudSql,
    actor: CloudActor,
    ids: string[],
  ): Promise<ChatAttachment[]> {
    if (!ids.length) return [];
    if (new Set(ids).size !== ids.length || ids.length > maximumChatAttachments)
      throw new CloudError(
        422,
        "attachment_limit",
        `Attach up to ${maximumChatAttachments} different files.`,
      );
    const rows = (
      await sql.query<AttachmentRow>(
        `SELECT ${columns} FROM ${from} WHERE a.organization_id=$1 AND a.id=ANY($2::uuid[]) AND a.created_by=$3
        AND a.issue_id IS NULL AND a.chat_id IS NULL AND a.state='ready' FOR UPDATE OF a`,
        [actor.organizationId, ids, actor.userId],
      )
    ).rows;
    if (rows.length !== ids.length)
      throw new CloudError(
        422,
        "attachment_unavailable",
        "An attached file is no longer available. Attach it again.",
      );
    return ids.map((id) => present(rows.find((row) => row.id === id)!));
  }

  async text(
    sql: CloudSql,
    organizationId: string,
    id: string,
    limit: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const bytes = await readChunks(sql, attachmentChunks, organizationId, id);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(0, limit),
    );
    return { text, truncated: bytes.length > limit };
  }

  async attachToTurn(
    sql: CloudSql,
    actor: CloudActor,
    ids: string[],
    chatId: string,
    turnId: string,
  ): Promise<ChatAttachment[]> {
    if (!ids.length) return [];
    if (new Set(ids).size !== ids.length || ids.length > maximumChatAttachments)
      throw new CloudError(
        422,
        "attachment_limit",
        `Attach up to ${maximumChatAttachments} different files.`,
      );
    const linked = (
      await sql.query<{ id: string }>(
        `UPDATE cloud_attachments SET chat_id=$3,turn_id=$4 WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND created_by=$5
        AND issue_id IS NULL AND chat_id IS NULL AND state='ready' RETURNING id`,
        [actor.organizationId, ids, chatId, turnId, actor.userId],
      )
    ).rows;
    if (linked.length !== ids.length)
      throw new CloudError(
        422,
        "attachment_unavailable",
        "An attached file is no longer available. Attach it again.",
      );
    return this.forChat(sql, actor.organizationId, chatId, [turnId]);
  }

  async forChat(
    sql: CloudSql,
    organizationId: string,
    chatId: string,
    turnIds?: string[],
  ): Promise<ChatAttachment[]> {
    return (
      await sql.query<AttachmentRow>(
        `SELECT ${columns} FROM ${from} WHERE a.organization_id=$1 AND a.chat_id=$2 AND a.state='ready'
        AND ($3::uuid[] IS NULL OR a.turn_id=ANY($3::uuid[])) ORDER BY a.created_at,a.id LIMIT 400`,
        [organizationId, chatId, turnIds ?? null],
      )
    ).rows.map(present);
  }

  chatImages(
    organizationId: string,
    turnId: string,
    limit: number,
    maximumBytes: number,
  ): Promise<{ attachment: ChatAttachment; bytes: Buffer }[]> {
    return this.database.transaction(async (sql) => {
      const rows = (
        await sql.query<AttachmentRow>(
          `SELECT ${columns} FROM ${from} JOIN cloud_chat_turns t ON t.organization_id=a.organization_id AND t.id=a.turn_id
          JOIN cloud_chat_turns current ON current.organization_id=t.organization_id AND current.chat_id=t.chat_id AND current.id=$2
          WHERE a.organization_id=$1 AND a.kind='image' AND a.state='ready' AND a.byte_length<=$4 AND t.sequence<=current.sequence
          ORDER BY t.sequence DESC,a.created_at DESC,a.id DESC LIMIT $3`,
          [organizationId, turnId, limit, maximumBytes],
        )
      ).rows.reverse();
      const files = [];
      for (const row of rows)
        files.push({
          attachment: present(row),
          bytes: await readChunks(
            sql,
            attachmentChunks,
            organizationId,
            row.id,
          ),
        });
      return files;
    });
  }

  copyToIssue(
    actor: CloudActor,
    sourceId: string,
    issueId: string,
    copyId: string,
  ): Promise<ChatAttachment> {
    return this.database.transaction(async (sql) => {
      const source = await this.accessible(sql, actor, sourceId);
      if (source.issueId === issueId) return present(source);
      await requireIssueAccess(sql, actor, issueId, true);
      const inserted = await sql.query(
        `INSERT INTO cloud_attachments (organization_id,id,issue_id,name,mime,kind,byte_length,width,height,source,state,created_by)
        SELECT organization_id,$3,$4,name,mime,kind,byte_length,width,height,$5,'ready',$6 FROM cloud_attachments
        WHERE organization_id=$1 AND id=$2 ON CONFLICT (organization_id,id) DO NOTHING RETURNING id`,
        [
          actor.organizationId,
          sourceId,
          copyId,
          issueId,
          source.chatId ? "agent" : source.source,
          actor.userId,
        ],
      );
      if (inserted.rows.length)
        await sql.query(
          `INSERT INTO cloud_attachment_chunks (organization_id,attachment_id,offset_bytes,bytes)
          SELECT organization_id,$3,offset_bytes,bytes FROM cloud_attachment_chunks WHERE organization_id=$1 AND attachment_id=$2`,
          [actor.organizationId, sourceId, copyId],
        );
      return present(await this.row(sql, actor.organizationId, copyId));
    });
  }

  createUploadLink(
    actor: CloudActor,
    issueId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return this.database.transaction(async (sql) => {
      await requireIssueAccess(sql, actor, issueId, true);
      await sql.query(
        "DELETE FROM cloud_attachment_upload_links WHERE expires_at<clock_timestamp()",
      );
      const token = randomBytes(32).toString("base64url");
      const expires = (
        await sql.query<{ expiresAt: string }>(
          `INSERT INTO cloud_attachment_upload_links (token_hash,organization_id,issue_id,created_by,expires_at)
          VALUES ($1,$2,$3,$4,clock_timestamp()+$5*interval '1 hour')
          RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`,
          [
            hashToken(token),
            actor.organizationId,
            issueId,
            actor.userId,
            uploadLinkHours,
          ],
        )
      ).rows[0]!;
      return { token, expiresAt: expires.expiresAt };
    });
  }

  async receiveUpload(
    token: string,
    file: { name: string; mime: string },
    body: ReadableStream<Uint8Array>,
  ): Promise<CloudAttachment> {
    const link = await this.database.transaction(async (sql) => {
      const row = (
        await sql.query<{
          organization_id: string;
          issue_id: string;
          created_by: string;
        }>(
          `UPDATE cloud_attachment_upload_links SET uploads=uploads+1 WHERE token_hash=$1 AND expires_at>clock_timestamp() AND uploads<$2
          RETURNING organization_id,issue_id,created_by`,
          [hashToken(token), uploadLinkLimit],
        )
      ).rows[0];
      if (!row)
        throw new CloudError(
          404,
          "upload_link_unavailable",
          "This upload link expired or reached its file limit.",
        );
      await requireIssueAccess(
        sql,
        { organizationId: row.organization_id, userId: row.created_by },
        row.issue_id,
        true,
      );
      return row;
    });
    return this.store(
      link.organization_id,
      link.created_by,
      { issueId: link.issue_id },
      { ...file, source: "client" },
      body,
    );
  }
}
