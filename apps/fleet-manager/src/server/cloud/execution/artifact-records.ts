import type {
  ArtifactReceipt,
  TaskArtifact,
  VerificationEvidence,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import type {
  WorkerFinish,
  ExecutionCheck,
} from "@machdoch/fleet-protocol/cloud-execution";
import { CloudError } from "../access";
import type { CloudSql } from "../database";

export const artifactColumns = `id,kind,name,byte_length AS "byteLength",sha256,input_digest AS "inputDigest",candidate_commit AS "candidateCommit",attempt_id AS "attemptId",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;
export interface StoredArtifact
  extends TaskArtifact, ArtifactReceipt, Record<string, unknown> {
  runId: string;
  epoch: number;
  metadataDigest: string;
  expired: boolean;
}
export async function readArtifact(
  sql: CloudSql,
  organizationId: string,
  id: string,
): Promise<StoredArtifact> {
  const row = (
    await sql.query<StoredArtifact>(
      `SELECT ${artifactColumns},run_id AS "runId",epoch,metadata_digest AS "metadataDigest",state,received_bytes AS "receivedBytes",expires_at<=clock_timestamp() AS expired
    FROM cloud_run_artifacts WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [organizationId, id],
    )
  ).rows[0];
  if (!row)
    throw new CloudError(
      404,
      "artifact_unavailable",
      "The task file is unavailable.",
    );
  return row;
}
export function artifactReceipt(artifact: StoredArtifact): ArtifactReceipt {
  return {
    id: artifact.id,
    state: artifact.state,
    receivedBytes: artifact.receivedBytes,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  };
}
export async function requireResultArtifacts(
  sql: CloudSql,
  organizationId: string,
  input: WorkerFinish,
  requiredChecks: ExecutionCheck[],
): Promise<void> {
  const artifacts = (
    await sql.query<{
      kind: string;
      sha256: string;
      evidence: VerificationEvidence | null;
    }>(
      `SELECT kind,sha256,evidence FROM cloud_run_artifacts WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 AND epoch=$4 AND candidate_commit=$5 AND input_digest=$6 AND state='ready'`,
      [
        organizationId,
        input.runId,
        input.attemptId,
        input.epoch,
        input.candidateCommit,
        input.inputDigest,
      ],
    )
  ).rows;
  if (!artifacts.some((artifact) => artifact.kind === "candidate"))
    throw new CloudError(
      409,
      "candidate_artifact_required",
      "Upload the candidate bundle before completing the task.",
    );
  for (const check of input.checks) {
    const evidence = artifacts.find(
      (artifact) =>
        artifact.kind === "verification" &&
        artifact.sha256 === check.evidenceDigest,
    )?.evidence;
    if (
      !evidence ||
      evidence.name !== check.name ||
      evidence.candidateCommit !== input.candidateCommit ||
      requiredChecks.some(
        (required) =>
          required.name === check.name && required.command !== evidence.command,
      ) ||
      check.passed !==
        (evidence.exitCode === 0 &&
          evidence.signal === null &&
          !evidence.timedOut)
    )
      throw new CloudError(
        409,
        "stored_evidence_required",
        "Upload matching check evidence before completing the task.",
      );
  }
}
