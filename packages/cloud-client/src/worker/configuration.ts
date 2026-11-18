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
const runnerLaunchSchema = runnerConfigurationSchema.extend({
  token: z.string().startsWith("mch_cloud_worker_"),
});
export type RunnerLaunch = z.infer<typeof runnerLaunchSchema>;
export async function readRunnerLaunch(path: string): Promise<RunnerLaunch> {
  const bytes = await readFile(path);
  if (bytes.length > 64 * 1024)
    throw new Error("Runner configuration exceeds its size limit");
  return runnerLaunchSchema.parse(JSON.parse(bytes.toString("utf8")));
}
export function receiveRunnerLaunch(): Promise<RunnerLaunch> {
  if (!process.send)
    throw new Error("A managed runner needs a parent process channel");
  return new Promise((resolve, reject) => {
    process.once("message", (message) => {
      try {
        resolve(runnerLaunchSchema.parse(message));
      } catch (error) {
        reject(error);
      }
    });
  });
}
