import { isAbsolute } from "node:path";
import { z } from "zod";

const path = z.string().max(32768).refine(isAbsolute);
export const sourcePackRequestSchema = z.strictObject({
  gitExecutable: path,
  repositoryDirectory: path,
  objectDirectory: path,
  stateDirectory: path,
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
});
export type SourcePackRequest = z.infer<typeof sourcePackRequestSchema>;
export const maximumSourcePackBytes = 64 * 1024 * 1024;
