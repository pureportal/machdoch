import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { sandboxConfigurationSchema } from "./sandbox/configuration.ts";
export const runnerConfigurationSchema = z.strictObject({
  origin: z.url(),
  stateDirectory: z
    .string()
    .refine(isAbsolute, "Use an absolute state directory"),
  pollIntervalMs: z.number().int().min(500).max(30000).default(3000),
  repairAttempts: z.number().int().min(0).max(3).default(2),
  sandbox: sandboxConfigurationSchema,
});
export type RunnerConfiguration = z.infer<typeof runnerConfigurationSchema>;
export async function readRunnerConfiguration(
  path: string,
): Promise<RunnerConfiguration> {
  const bytes = await readFile(path);
  if (bytes.length > 64 * 1024)
    throw new Error("Runner configuration exceeds its size limit");
  return runnerConfigurationSchema.parse(JSON.parse(bytes.toString("utf8")));
}
