import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactInput,
  VerificationEvidence,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import type { WorkerClaim } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudRuntime } from "../runtime";

export function verificationFixture(
  candidateCommit: string,
  changes: Partial<VerificationEvidence> = {},
): VerificationEvidence {
  return {
    name: "unit",
    candidateCommit,
    command: "node --test",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 1,
    stdout: "Passed",
    stderr: "",
    ...changes,
  };
}
export async function storeTestArtifact(
  runtime: CloudRuntime,
  token: string,
  claim: WorkerClaim,
  kind: ArtifactInput["kind"],
  bytes: Buffer,
  candidateCommit: string | null,
  name: string,
) {
  const input = {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    artifactId: randomUUID(),
    kind,
    name,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    inputDigest: claim.inputDigest,
    candidateCommit,
  };
  await runtime.execution.uploads.begin(token, input);
  const chunks: { offset: number; sha256: string; content: string }[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const chunk = bytes.subarray(offset, offset + 32768);
    chunks.push({
      offset,
      sha256: createHash("sha256").update(chunk).digest("hex"),
      content: chunk.toString("base64"),
    });
  }
  await runtime.database.transaction(async (sql) => {
    await sql.query(
      "INSERT INTO cloud_artifact_chunks(organization_id,artifact_id,offset_bytes,sha256,bytes) SELECT a.organization_id,a.id,(value->>'offset')::integer,value->>'sha256',decode(value->>'content','base64') FROM cloud_run_artifacts a CROSS JOIN jsonb_array_elements($2::jsonb) AS chunks(value) WHERE a.id=$1",
      [input.artifactId, JSON.stringify(chunks)],
    );
    await sql.query(
      "UPDATE cloud_run_artifacts SET received_bytes=byte_length WHERE id=$1",
      [input.artifactId],
    );
  });
  await runtime.execution.uploads.complete(token, input);
  return input;
}
