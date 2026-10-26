import { repositoryRequestSchema } from "@machdoch/fleet-protocol/cloud-repository";
import { attemptIdentitySchema } from "@machdoch/fleet-protocol/cloud-execution";
import type { z } from "zod";

export const workerRepositorySchema = repositoryRequestSchema.safeExtend(
  attemptIdentitySchema.shape,
);
export type WorkerRepositoryRequest = z.infer<typeof workerRepositorySchema>;
