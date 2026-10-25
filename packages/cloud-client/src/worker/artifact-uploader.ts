import {
  artifactChunkBytes,
  artifactInputSchema,
  artifactReceiptSchema,
  type ArtifactInput,
  type ArtifactReceipt,
} from "@machdoch/fleet-protocol/cloud-artifacts";

export type ArtifactRequest = (
  operation: "begin" | "chunk" | "complete",
  input: Record<string, unknown>,
) => Promise<unknown>;

export async function uploadArtifact(
  request: ArtifactRequest,
  attempt: { runId: string; attemptId: string; epoch: number },
  input: ArtifactInput,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<ArtifactReceipt> {
  const metadata = artifactInputSchema.parse(input);
  const validate = (value: unknown): ArtifactReceipt => {
    const receipt = artifactReceiptSchema.parse(value);
    if (
      receipt.id !== metadata.artifactId ||
      receipt.sha256 !== metadata.sha256 ||
      receipt.byteLength !== metadata.byteLength ||
      receipt.receivedBytes > receipt.byteLength ||
      (receipt.receivedBytes !== receipt.byteLength &&
        receipt.receivedBytes % artifactChunkBytes !== 0)
    )
      throw new Error("Artifact receipt does not match the upload");
    if (receipt.state === "abandoned")
      throw new Error("The artifact upload was abandoned");
    return receipt;
  };
  let receipt = validate(await request("begin", { ...attempt, ...metadata }));
  if (receipt.state === "ready") {
    if (receipt.receivedBytes !== metadata.byteLength)
      throw new Error("Completed artifact has an incomplete receipt");
    return receipt;
  }
  while (receipt.receivedBytes < metadata.byteLength) {
    const offset = receipt.receivedBytes;
    const length = Math.min(artifactChunkBytes, metadata.byteLength - offset);
    const bytes = await read(offset, length);
    if (bytes.byteLength !== length)
      throw new Error("Artifact source changed during upload");
    receipt = validate(
      await request("chunk", {
        ...attempt,
        artifactId: metadata.artifactId,
        offset,
        content: Buffer.from(bytes).toString("base64"),
      }),
    );
    if (
      receipt.receivedBytes !== offset + length ||
      receipt.state !== "uploading"
    )
      throw new Error("Artifact upload acknowledgment is inconsistent");
  }
  receipt = validate(
    await request("complete", { ...attempt, artifactId: metadata.artifactId }),
  );
  if (
    receipt.state !== "ready" ||
    receipt.receivedBytes !== metadata.byteLength
  )
    throw new Error("Artifact upload was not completed");
  return receipt;
}
