import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ArtifactInput } from "@machdoch/fleet-protocol/cloud-artifacts";
import { uploadArtifact, type ArtifactRequest } from "../../../packages/cloud-client/src/worker/artifact-uploader.ts";

const attempt = { runId: randomUUID(), attemptId: randomUUID(), epoch: 1 };
function metadata(bytes: Buffer): ArtifactInput {
  return {
    artifactId: randomUUID(),
    kind: "diff",
    name: "changes.patch",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    inputDigest: "a".repeat(64),
    candidateCommit: "b".repeat(40),
  };
}

await test("resumes at the durable offset after a chunk acknowledgment is lost", async () => {
  const bytes = Buffer.alloc(40000, 4);
  const input = metadata(bytes);
  let received = 0;
  let ready = false;
  let lost = false;
  const written: number[] = [];
  const request: ArtifactRequest = async (operation, payload) => {
    if (operation === "chunk") {
      const part = Buffer.from(String(payload.content), "base64");
      assert.equal(payload.offset, received);
      assert.deepEqual(part, bytes.subarray(received, received + part.length));
      written.push(received);
      received += part.length;
      if (!lost) {
        lost = true;
        throw new Error("Response lost");
      }
    }
    if (operation === "complete") ready = true;
    return {
      id: input.artifactId,
      state: ready ? "ready" : "uploading",
      receivedBytes: received,
      byteLength: bytes.length,
      sha256: input.sha256,
    };
  };
  const read = async (offset: number, length: number) =>
    bytes.subarray(offset, offset + length);
  await assert.rejects(
    uploadArtifact(request, attempt, input, read),
    /Response lost/,
  );
  assert.equal(
    (await uploadArtifact(request, attempt, input, read)).state,
    "ready",
  );
  assert.deepEqual(written, [0, 32768]);
  assert.equal(
    (
      await uploadArtifact(request, attempt, input, async () => {
        throw new Error("Should not read completed content");
      })
    ).state,
    "ready",
  );
});

await test("rejects a changed source before sending an incomplete chunk", async () => {
  const input = metadata(Buffer.alloc(40000));
  const operations: string[] = [];
  await assert.rejects(
    uploadArtifact(
      async (operation) => {
        operations.push(operation);
        return {
          id: input.artifactId,
          state: "uploading",
          receivedBytes: 0,
          byteLength: input.byteLength,
          sha256: input.sha256,
        };
      },
      attempt,
      input,
      async () => Buffer.alloc(10),
    ),
    /source changed/,
  );
  assert.deepEqual(operations, ["begin"]);
});

for (const change of [
  { id: randomUUID() },
  { sha256: "c".repeat(64) },
  { receivedBytes: 1 },
  { state: "abandoned" },
])
  await test(`rejects inconsistent upload receipt ${Object.keys(change)[0]}`, async () => {
    const input = metadata(Buffer.alloc(40000));
    await assert.rejects(
      uploadArtifact(
        async () => ({
          id: input.artifactId,
          state: "uploading",
          receivedBytes: 0,
          byteLength: input.byteLength,
          sha256: input.sha256,
          ...change,
        }),
        attempt,
        input,
        async () => {
          throw new Error("Unexpected source read");
        },
      ),
      /receipt|abandoned/,
    );
  });

await test("stores empty diffs with no source reads or fabricated chunk", async () => {
  const input = metadata(Buffer.alloc(0));
  const operations: string[] = [];
  const receipt = await uploadArtifact(
    async (operation) => {
      operations.push(operation);
      return {
        id: input.artifactId,
        state: operation === "complete" ? "ready" : "uploading",
        receivedBytes: 0,
        byteLength: 0,
        sha256: input.sha256,
      };
    },
    attempt,
    input,
    async () => {
      throw new Error("Unexpected source read");
    },
  );
  assert.equal(receipt.state, "ready");
  assert.deepEqual(operations, ["begin", "complete"]);
});
