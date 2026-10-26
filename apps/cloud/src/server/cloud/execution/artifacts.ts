import type {
  ArtifactPreview,
  TaskArtifact,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import type { CloudActor } from "../../../lib/cloud-contract";
import { CloudError, requireTeam } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { artifactColumns } from "./artifact-records";

async function readVisibleArtifact(
  sql: CloudSql,
  actor: CloudActor,
  runId: string,
  id: string,
): Promise<TaskArtifact> {
  const reference = (
    await sql.query<{ team_id: string }>(
      "SELECT team_id FROM cloud_runs WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, runId],
    )
  ).rows[0];
  if (!reference)
    throw new CloudError(404, "not_found", "Task is unavailable.");
  await requireTeam(sql, actor, reference.team_id);
  const artifact = (
    await sql.query<TaskArtifact & Record<string, unknown>>(
      `SELECT ${artifactColumns} FROM cloud_run_artifacts WHERE organization_id=$1 AND run_id=$2 AND id=$3 AND state='ready'`,
      [actor.organizationId, runId, id],
    )
  ).rows[0];
  if (!artifact)
    throw new CloudError(
      404,
      "artifact_unavailable",
      "The task file is unavailable.",
    );
  return artifact;
}

export class CloudArtifacts {
  private downloads = 0;
  constructor(private readonly database: CloudDatabase) {}

  preview(
    actor: CloudActor,
    runId: string,
    id: string,
  ): Promise<ArtifactPreview> {
    return this.database.transaction(async (sql) => {
      const artifact = await readVisibleArtifact(sql, actor, runId, id);
      if (artifact.kind === "candidate")
        throw new CloudError(
          415,
          "preview_unavailable",
          "Download this file to inspect it.",
        );
      const rows = (
        await sql.query<{ bytes: Uint8Array }>(
          "SELECT bytes FROM cloud_artifact_chunks WHERE organization_id=$1 AND artifact_id=$2 ORDER BY offset_bytes LIMIT 4",
          [actor.organizationId, id],
        )
      ).rows;
      const bytes = Buffer.concat(rows.map((row) => row.bytes));
      const truncated = bytes.byteLength < artifact.byteLength;
      return {
        text: new TextDecoder("utf8")
          .decode(bytes, { stream: truncated })
          .replace(/\p{Cc}/gu, (character) =>
            "\t\n\r".includes(character) ? character : "�",
          ),
        truncated,
      };
    });
  }

  async download(
    actor: CloudActor,
    runId: string,
    id: string,
    signal: AbortSignal,
  ): Promise<Response> {
    if (this.downloads >= 8)
      throw new CloudError(
        503,
        "downloads_busy",
        "File downloads are busy. Try again shortly.",
      );
    this.downloads++;
    let opened = false;
    try {
      const artifact = await this.database.transaction((sql) =>
        readVisibleArtifact(sql, actor, runId, id),
      );
      const abort = AbortSignal.any([
        signal,
        AbortSignal.timeout(10 * 60 * 1000),
      ]);
      abort.throwIfAborted();
      let offset = 0;
      let released = false;
      let stop: () => void;
      const release = () => {
        if (released) return;
        released = true;
        this.downloads--;
        abort.removeEventListener("abort", stop);
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stop = () => {
            release();
            controller.error(new Error("File download ended"));
          };
          abort.addEventListener("abort", stop, { once: true });
        },
        pull: async (controller) => {
          try {
            abort.throwIfAborted();
            if (offset === artifact.byteLength) {
              release();
              controller.close();
              return;
            }
            const bytes = await this.database.transaction(async (sql) => {
              await readVisibleArtifact(sql, actor, runId, id);
              const rows = (
                await sql.query<{ offset_bytes: number; bytes: Uint8Array }>(
                  "SELECT offset_bytes,bytes FROM cloud_artifact_chunks WHERE organization_id=$1 AND artifact_id=$2 AND offset_bytes>=$3 ORDER BY offset_bytes LIMIT 16",
                  [actor.organizationId, id, offset],
                )
              ).rows;
              if (!rows.length) throw new Error("Stored file is incomplete");
              for (const row of rows) {
                if (row.offset_bytes !== offset)
                  throw new Error("Stored file has a missing range");
                offset += row.bytes.byteLength;
              }
              if (offset > artifact.byteLength)
                throw new Error("Stored file exceeds its declared length");
              return Buffer.concat(rows.map((row) => row.bytes));
            });
            abort.throwIfAborted();
            if (!released) controller.enqueue(bytes);
          } catch {
            if (!released) {
              release();
              controller.error(new Error("File download was interrupted"));
            }
          }
        },
        cancel: release,
      });
      opened = true;
      return new Response(body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${artifact.name}"`,
          "Content-Length": String(artifact.byteLength),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          ETag: `"${artifact.sha256}"`,
        },
      });
    } finally {
      if (!opened) this.downloads--;
    }
  }
}
