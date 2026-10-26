import { createHash, randomUUID } from "node:crypto";
import { uploadArtifact } from "../../../packages/cloud-client/src/worker/artifact-uploader.ts";

export function verificationRecord(candidateCommit, changes = {}) {
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
export async function uploadRunnerArtifact(
  send,
  claim,
  kind,
  name,
  bytes,
  candidateCommit,
  artifactId = randomUUID(),
) {
  const metadata = {
    artifactId,
    kind,
    name,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    inputDigest: claim.inputDigest,
    candidateCommit,
  };
  const receipt = await uploadArtifact(
    (operation, input) => send(`artifacts/${operation}`, input),
    { runId: claim.runId, attemptId: claim.attemptId, epoch: claim.epoch },
    metadata,
    async (offset, length) => bytes.subarray(offset, offset + length),
  );
  return { ...metadata, ...receipt };
}
