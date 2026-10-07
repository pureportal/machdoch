import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { eq } from "semver";

function decodeBase64(value: string): Buffer {
  const encoded = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("Invalid update signature encoding.");
  return Buffer.from(encoded, "base64");
}

export function verifyUpdateSignature(
  digest: Buffer,
  encodedSignature: string,
  encodedPublicKey: string,
  version: string,
): void {
  const publicLines = decodeBase64(encodedPublicKey)
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  const signatureLines = decodeBase64(encodedSignature)
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  if (publicLines.length !== 2 || signatureLines.length !== 4)
    throw new Error("Invalid update signature format.");
  const publicPacket = decodeBase64(publicLines[1]!);
  const signaturePacket = decodeBase64(signatureLines[1]!);
  if (
    publicPacket.length !== 42 ||
    publicPacket.subarray(0, 2).toString() !== "Ed" ||
    signaturePacket.length !== 74 ||
    signaturePacket.subarray(0, 2).toString() !== "ED" ||
    !timingSafeEqual(
      publicPacket.subarray(2, 10),
      signaturePacket.subarray(2, 10),
    ) ||
    !signatureLines[2]!.startsWith("trusted comment: ")
  )
    throw new Error(
      "The update signature does not match the trusted signing key.",
    );
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicPacket.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const signature = signaturePacket.subarray(10);
  const comment = signatureLines[2]!.slice("trusted comment: ".length);
  const globalSignature = decodeBase64(signatureLines[3]!);
  if (
    digest.length !== 64 ||
    globalSignature.length !== 64 ||
    !verify(null, digest, key, signature) ||
    !verify(
      null,
      Buffer.concat([signature, Buffer.from(comment)]),
      key,
      globalSignature,
    )
  )
    throw new Error(
      "Update signature verification failed. The installed files were not changed.",
    );
  const signedVersions = comment
    .split("\t")
    .filter((field) => field.startsWith("version:"));
  if (
    signedVersions.length !== 1 ||
    !eq(signedVersions[0]!.slice(8), version)
  ) {
    throw new Error(
      "The signed update version does not match the release version.",
    );
  }
}
