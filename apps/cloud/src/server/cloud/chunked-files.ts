import { CloudError } from "./access";
import type { CloudDatabase, CloudSql } from "./database";

export const fileChunkBytes = 256 * 1024;

export interface ChunkTable {
  table: "cloud_release_media_chunks" | "cloud_attachment_chunks";
  owner: "media_id" | "attachment_id";
}

export interface StoredFile {
  mime: string;
  name: string;
  total: number;
  start: number;
  end: number;
  body: ReadableStream<Uint8Array>;
}

export async function writeChunks(
  database: CloudDatabase,
  chunks: ChunkTable,
  organizationId: string,
  id: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
  maximumBytes: number,
  tooLarge: () => CloudError,
): Promise<{ bytes: number; first: Uint8Array | null }> {
  let offset = 0;
  let first: Uint8Array | null = null;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = async (all: boolean) => {
    while (pendingBytes >= fileChunkBytes || (all && pendingBytes > 0)) {
      const merged = Buffer.concat(pending);
      const chunk = merged.subarray(0, fileChunkBytes);
      const rest = merged.subarray(chunk.length);
      first ??= chunk;
      await database.transaction((sql) =>
        sql.query(
          `INSERT INTO ${chunks.table} (organization_id,${chunks.owner},offset_bytes,bytes) VALUES ($1,$2,$3,$4)`,
          [organizationId, id, offset, chunk],
        ),
      );
      offset += chunk.length;
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  };
  const append = async (part: Uint8Array) => {
    if (offset + pendingBytes + part.byteLength > maximumBytes)
      throw tooLarge();
    pending.push(part);
    pendingBytes += part.byteLength;
    await flush(false);
  };
  if (body instanceof Uint8Array) await append(body);
  else {
    const reader = body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        await append(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  await flush(true);
  return { bytes: offset, first };
}

export function byteRange(
  total: number,
  range: string | null,
): { start: number; end: number } {
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = total - 1;
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    } else {
      start = Math.max(0, total - Number(match[2]));
    }
    if (start > end || start >= total)
      throw new CloudError(
        416,
        "range_unavailable",
        "The requested range is unavailable.",
      );
  }
  return { start, end };
}

export function streamChunks(
  database: CloudDatabase,
  chunks: ChunkTable,
  organizationId: string,
  id: string,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let position = start - (start % fileChunkBytes);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (position > end) {
        controller.close();
        return;
      }
      const row = (
        await database.transaction((sql) =>
          sql.query<{ bytes: Uint8Array }>(
            `SELECT bytes FROM ${chunks.table} WHERE organization_id=$1 AND ${chunks.owner}=$2 AND offset_bytes=$3`,
            [organizationId, id, position],
          ),
        )
      ).rows[0];
      if (!row) {
        controller.error(new Error("File chunk is missing."));
        return;
      }
      const bytes = new Uint8Array(row.bytes);
      const from = Math.max(0, start - position);
      const to = Math.min(bytes.length, end - position + 1);
      controller.enqueue(bytes.subarray(from, to));
      position += bytes.length;
    },
  });
}

export async function readChunks(
  sql: CloudSql,
  chunks: ChunkTable,
  organizationId: string,
  id: string,
): Promise<Buffer> {
  const rows = (
    await sql.query<{ bytes: Uint8Array }>(
      `SELECT bytes FROM ${chunks.table} WHERE organization_id=$1 AND ${chunks.owner}=$2 ORDER BY offset_bytes`,
      [organizationId, id],
    )
  ).rows;
  return Buffer.concat(rows.map((row) => Buffer.from(row.bytes)));
}
