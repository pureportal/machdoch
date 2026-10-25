import { z } from "zod";

export const maximumArtifactBytes = 64 * 1024 * 1024;
export const artifactChunkBytes = 32 * 1024;
export const artifactKinds = [
  "candidate",
  "diff",
  "verification",
  "log",
] as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const artifactInputSchema = z
  .strictObject({
    artifactId: z.uuid(),
    kind: z.enum(artifactKinds),
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/)
      .refine(
        (value) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value),
        "Choose a file name that can be downloaded on any platform.",
      ),
    byteLength: z.number().int().min(0).max(maximumArtifactBytes),
    sha256,
    inputDigest: sha256,
    candidateCommit: commit.nullable(),
  })
  .refine(
    (value) => value.kind === "log" || value.candidateCommit !== null,
    "Bind this file to a candidate commit.",
  )
  .refine(
    (value) =>
      !["candidate", "verification"].includes(value.kind) ||
      value.byteLength > 0,
    "This file cannot be empty.",
  )
  .refine(
    (value) => value.kind !== "verification" || value.byteLength <= 512 * 1024,
    "Check evidence must fit within 512 KiB.",
  );
export const artifactChunkSchema = z.strictObject({
  artifactId: z.uuid(),
  offset: z.number().int().min(0).max(maximumArtifactBytes),
  content: z
    .string()
    .min(4)
    .max(43692)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const artifactIdentitySchema = z.strictObject({ artifactId: z.uuid() });
export const verificationEvidenceSchema = z.strictObject({
  name: z.string().min(1).max(120),
  candidateCommit: commit,
  command: z.string().min(1).max(16384),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(80).nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().int().min(0).max(86400000),
  stdout: z.string().max(128 * 1024),
  stderr: z.string().max(128 * 1024),
});
export type ArtifactInput = z.infer<typeof artifactInputSchema>;
export type ArtifactChunk = z.infer<typeof artifactChunkSchema>;
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;
export interface TaskArtifact extends Omit<ArtifactInput, "artifactId"> {
  id: string;
  attemptId: string;
  createdAt: string;
}
export const artifactReceiptSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(["uploading", "ready", "abandoned"]),
  receivedBytes: z.number().int().min(0).max(maximumArtifactBytes),
  byteLength: z.number().int().min(0).max(maximumArtifactBytes),
  sha256,
});
export type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>;
export interface ArtifactPreview {
  text: string;
  truncated: boolean;
}
