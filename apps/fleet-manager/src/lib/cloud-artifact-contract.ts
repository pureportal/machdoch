import {
  artifactInputSchema,
  artifactChunkSchema,
  artifactIdentitySchema,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import { attemptIdentitySchema } from "@machdoch/fleet-protocol/cloud-execution";
import type { z } from "zod";

export const workerArtifactInputSchema = artifactInputSchema.safeExtend(
  attemptIdentitySchema.shape,
);
export const workerArtifactChunkSchema = artifactChunkSchema.extend(
  attemptIdentitySchema.shape,
);
export const workerArtifactIdentitySchema = artifactIdentitySchema.extend(
  attemptIdentitySchema.shape,
);
export type WorkerArtifactInput = z.infer<typeof workerArtifactInputSchema>;
export type WorkerArtifactChunk = z.infer<typeof workerArtifactChunkSchema>;
export type WorkerArtifactIdentity = z.infer<
  typeof workerArtifactIdentitySchema
>;
