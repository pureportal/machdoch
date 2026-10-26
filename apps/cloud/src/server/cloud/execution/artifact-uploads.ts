import { createHash } from "node:crypto";
import {
  artifactChunkBytes,
  verificationEvidenceSchema,
  type ArtifactReceipt,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import type {
  WorkerArtifactInput,
  WorkerArtifactChunk,
  WorkerArtifactIdentity,
} from "../../../lib/cloud-artifact-contract";
import { CloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { executionDigest, mayExecute, readAttempt } from "./attempts";
import {
  artifactReceipt,
  readArtifact,
  type StoredArtifact,
} from "./artifact-records";
import { requireWorker, type WorkerIdentity } from "./workers";
import { recordRun } from "./records";

async function authorize(
  sql: CloudSql,
  token: string,
  input: WorkerArtifactIdentity,
) {
  const worker = await requireWorker(sql, token);
  const { run, attempt } = await readAttempt(sql, worker, input);
  if (!attempt.acceptDigest || !(await mayExecute(sql, worker, run, attempt)))
    throw new CloudError(
      409,
      "attempt_stopped",
      "Task file uploads require a current accepted attempt.",
    );
  return { worker, run };
}
async function ownedArtifact(
  sql: CloudSql,
  worker: WorkerIdentity,
  input: WorkerArtifactIdentity,
): Promise<StoredArtifact> {
  const artifact = await readArtifact(
    sql,
    worker.organizationId,
    input.artifactId,
  );
  if (
    artifact.runId !== input.runId ||
    artifact.attemptId !== input.attemptId ||
    artifact.epoch !== input.epoch
  )
    throw new CloudError(
      404,
      "artifact_unavailable",
      "This task file does not belong to the attempt.",
    );
  return artifact;
}
function requireUpload(artifact: StoredArtifact): void {
  if (artifact.state !== "uploading" || artifact.expired)
    throw new CloudError(
      409,
      "upload_closed",
      "Start a new upload for this file.",
    );
}

export class CloudArtifactUploads {
  constructor(private readonly database: CloudDatabase) {}

  begin(token: string, input: WorkerArtifactInput): Promise<ArtifactReceipt> {
    return this.database.transaction(async (sql) => {
      const { worker, run } = await authorize(sql, token, input);
      if (input.inputDigest !== run.inputDigest)
        throw new CloudError(
          409,
          "manifest_mismatch",
          "Bind the file to this task's input digest.",
        );
      const digest = executionDigest([
        input.kind,
        input.name,
        input.byteLength,
        input.sha256,
        input.inputDigest,
        input.candidateCommit,
      ]);
      if (
        (
          await sql.query(
            "SELECT id FROM cloud_run_artifacts WHERE organization_id=$1 AND id=$2",
            [worker.organizationId, input.artifactId],
          )
        ).rows.length
      ) {
        const artifact = await ownedArtifact(sql, worker, input);
        if (artifact.metadataDigest !== digest)
          throw new CloudError(
            409,
            "artifact_conflict",
            "This upload ID already belongs to a different file.",
          );
        return artifactReceipt(artifact);
      }
      await sql.query(
        `WITH expired AS (UPDATE cloud_run_artifacts SET state='abandoned' WHERE organization_id=$1 AND id IN
        (SELECT id FROM cloud_run_artifacts WHERE organization_id=$1 AND state='uploading' AND expires_at<=clock_timestamp() ORDER BY id LIMIT 100) RETURNING id)
        DELETE FROM cloud_artifact_chunks c USING expired e WHERE c.organization_id=$1 AND c.artifact_id=e.id`,
        [worker.organizationId],
      );
      const usage = (
        await sql.query<{
          count: number;
          runBytes: number;
          organizationBytes: number;
        }>(
          `SELECT count(*) FILTER (WHERE run_id=$2)::integer AS count,
        COALESCE(sum(byte_length) FILTER (WHERE run_id=$2 AND state<>'abandoned'),0)::double precision AS "runBytes",
        COALESCE(sum(byte_length) FILTER (WHERE state<>'abandoned'),0)::double precision AS "organizationBytes"
        FROM cloud_run_artifacts WHERE organization_id=$1`,
          [worker.organizationId, run.id],
        )
      ).rows[0]!;
      if (
        usage.count >= 128 ||
        usage.runBytes + input.byteLength > 256 * 1024 * 1024 ||
        usage.organizationBytes + input.byteLength > 10 * 1024 * 1024 * 1024
      )
        throw new CloudError(
          409,
          "artifact_capacity",
          "Task file storage is at capacity. Contact an administrator.",
        );
      if (
        input.kind === "candidate" &&
        (
          await sql.query(
            "SELECT id FROM cloud_run_artifacts WHERE organization_id=$1 AND attempt_id=$2 AND candidate_commit=$3 AND kind='candidate' AND state<>'abandoned'",
            [worker.organizationId, input.attemptId, input.candidateCommit],
          )
        ).rows.length
      )
        throw new CloudError(
          409,
          "candidate_exists",
          "Resume the existing candidate upload or abandon it before starting another.",
        );
      await sql.query(
        `INSERT INTO cloud_run_artifacts(organization_id,id,run_id,attempt_id,epoch,kind,name,byte_length,sha256,input_digest,candidate_commit,metadata_digest,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,LEAST($13::timestamptz,clock_timestamp()+interval '15 minutes'))`,
        [
          worker.organizationId,
          input.artifactId,
          run.id,
          input.attemptId,
          input.epoch,
          input.kind,
          input.name,
          input.byteLength,
          input.sha256,
          input.inputDigest,
          input.candidateCommit,
          digest,
          run.deadlineAt,
        ],
      );
      return artifactReceipt(
        await readArtifact(sql, worker.organizationId, input.artifactId),
      );
    });
  }

  write(token: string, input: WorkerArtifactChunk): Promise<ArtifactReceipt> {
    const bytes = Buffer.from(input.content, "base64");
    if (!bytes.length || bytes.length > artifactChunkBytes)
      throw new CloudError(
        413,
        "chunk_too_large",
        "Upload file chunks of at most 32 KiB.",
      );
    const digest = createHash("sha256").update(bytes).digest("hex");
    return this.database.transaction(async (sql) => {
      const { worker } = await authorize(sql, token, input);
      const artifact = await ownedArtifact(sql, worker, input);
      const previous = (
        await sql.query<{ sha256: string }>(
          "SELECT sha256 FROM cloud_artifact_chunks WHERE organization_id=$1 AND artifact_id=$2 AND offset_bytes=$3",
          [worker.organizationId, artifact.id, input.offset],
        )
      ).rows[0];
      if (previous) {
        if (previous.sha256 !== digest)
          throw new CloudError(
            409,
            "chunk_conflict",
            "Retry the original bytes for this upload offset.",
          );
        return artifactReceipt(artifact);
      }
      requireUpload(artifact);
      if (
        input.offset !== artifact.receivedBytes ||
        input.offset + bytes.length > artifact.byteLength
      )
        throw new CloudError(
          409,
          "upload_offset",
          "Resume the upload from its recorded byte offset.",
        );
      if (
        bytes.length !==
        Math.min(artifactChunkBytes, artifact.byteLength - input.offset)
      )
        throw new CloudError(
          422,
          "chunk_size",
          "Send 32 KiB chunks followed by the exact remaining bytes.",
        );
      await sql.query(
        "INSERT INTO cloud_artifact_chunks VALUES ($1,$2,$3,$4,$5)",
        [worker.organizationId, artifact.id, input.offset, digest, bytes],
      );
      await sql.query(
        "UPDATE cloud_run_artifacts SET received_bytes=received_bytes+$3 WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, artifact.id, bytes.length],
      );
      return {
        ...artifactReceipt(artifact),
        receivedBytes: artifact.receivedBytes + bytes.length,
      };
    });
  }

  complete(
    token: string,
    input: WorkerArtifactIdentity,
  ): Promise<ArtifactReceipt> {
    return this.database.transaction(async (sql) => {
      const { worker, run } = await authorize(sql, token, input);
      const artifact = await ownedArtifact(sql, worker, input);
      if (artifact.state === "ready") return artifactReceipt(artifact);
      requireUpload(artifact);
      if (artifact.receivedBytes !== artifact.byteLength)
        throw new CloudError(
          409,
          "upload_incomplete",
          "Upload the remaining bytes before completing this file.",
        );
      const hash = createHash("sha256");
      const evidenceBytes: Uint8Array[] = [];
      let offset = 0;
      while (offset < artifact.byteLength) {
        const chunks = (
          await sql.query<{ offset_bytes: number; bytes: Uint8Array }>(
            "SELECT offset_bytes,bytes FROM cloud_artifact_chunks WHERE organization_id=$1 AND artifact_id=$2 AND offset_bytes>=$3 ORDER BY offset_bytes LIMIT 128",
            [worker.organizationId, artifact.id, offset],
          )
        ).rows;
        if (!chunks.length)
          throw new CloudError(
            409,
            "upload_incomplete",
            "The uploaded file is incomplete.",
          );
        for (const chunk of chunks) {
          if (chunk.offset_bytes !== offset)
            throw new CloudError(
              409,
              "upload_incomplete",
              "The uploaded file contains a missing range.",
            );
          hash.update(chunk.bytes);
          offset += chunk.bytes.byteLength;
          if (artifact.kind === "verification") evidenceBytes.push(chunk.bytes);
        }
      }
      if (
        offset !== artifact.byteLength ||
        hash.digest("hex") !== artifact.sha256
      )
        throw new CloudError(
          409,
          "artifact_digest",
          "The uploaded bytes do not match the file digest. Abandon this upload and start a new one.",
        );
      let evidence = null;
      if (artifact.kind === "verification") {
        try {
          evidence = verificationEvidenceSchema.parse(
            JSON.parse(
              new TextDecoder("utf8", { fatal: true }).decode(
                Buffer.concat(evidenceBytes),
              ),
            ),
          );
        } catch {
          throw new CloudError(
            422,
            "invalid_evidence",
            "Upload a valid check record with its command, result and candidate commit.",
          );
        }
        if (evidence.candidateCommit !== artifact.candidateCommit)
          throw new CloudError(
            409,
            "candidate_mismatch",
            "The check record belongs to a different candidate commit.",
          );
      }
      await sql.query(
        "UPDATE cloud_run_artifacts SET state='ready',evidence=$3 WHERE organization_id=$1 AND id=$2",
        [
          worker.organizationId,
          artifact.id,
          evidence ? JSON.stringify(evidence) : null,
        ],
      );
      await sql.query(
        "UPDATE cloud_runs SET revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, run.id],
      );
      await recordRun(sql, worker.organizationId, run.id, "Task file stored");
      return { ...artifactReceipt(artifact), state: "ready" };
    });
  }

  abandon(
    token: string,
    input: WorkerArtifactIdentity,
  ): Promise<ArtifactReceipt> {
    return this.database.transaction(async (sql) => {
      const { worker } = await authorize(sql, token, input);
      const artifact = await ownedArtifact(sql, worker, input);
      if (artifact.state === "ready")
        throw new CloudError(
          409,
          "artifact_immutable",
          "Completed task files cannot be replaced or abandoned.",
        );
      await sql.query(
        "UPDATE cloud_run_artifacts SET state='abandoned' WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, artifact.id],
      );
      await sql.query(
        "DELETE FROM cloud_artifact_chunks WHERE organization_id=$1 AND artifact_id=$2",
        [worker.organizationId, artifact.id],
      );
      return { ...artifactReceipt(artifact), state: "abandoned" };
    });
  }
}
