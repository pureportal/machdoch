import { z } from "zod";
import type { VirtualMachineSandbox } from "./sandbox/virtual-machine.ts";

export const shellResultSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});
export const artifactDescriptorSchema = z.strictObject({
  byteLength: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const exportedFileSchema = z.strictObject({
  content: z.string(),
  encoding: z.literal("base64"),
  offset: z.number().int(),
  nextOffset: z.number().int(),
  size: z.number().int(),
});
export interface ActiveEnvironment {
  sandbox: VirtualMachineSandbox;
  signal: AbortSignal;
}

export async function guest<T>(
  environment: ActiveEnvironment,
  tool: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  environment.signal.throwIfAborted();
  const response = await environment.sandbox.call(
    tool,
    args,
    environment.signal,
  );
  if (!response.ok) throw new Error(response.error);
  return schema.parse(response.result);
}
export function shell(
  environment: ActiveEnvironment,
  command: string,
  timeoutMs = 30000,
  directory?: string,
) {
  return guest(
    environment,
    "shell",
    { command, timeoutMs, ...(directory ? { directory } : {}) },
    shellResultSchema,
  );
}
export async function requireShell(
  environment: ActiveEnvironment,
  command: string,
  timeoutMs = 30000,
) {
  const result = await shell(environment, command, timeoutMs);
  if (result.exitCode !== 0 || result.timedOut || result.signal)
    throw new Error(
      result.stderr.trim().slice(-2000) || "Sandbox command failed",
    );
  return result;
}
export async function exportBytes(
  environment: ActiveEnvironment,
  name: string,
  size: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < size; offset += 32768) {
    const length = Math.min(32768, size - offset);
    const response = await guest(
      environment,
      "export_artifact",
      { path: name, offset, limit: length },
      exportedFileSchema,
    );
    const bytes = Buffer.from(response.content, "base64");
    if (
      response.size !== size ||
      response.offset !== offset ||
      bytes.length !== length ||
      response.nextOffset !== offset + length
    )
      throw new Error("Artifact changed during export");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function importBytes(
  environment: ActiveEnvironment,
  name: string,
  bytes: Buffer,
): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const chunk = bytes.subarray(offset, offset + 32768);
    const receipt = await guest(
      environment,
      "write_artifact",
      { path: name, offset, content: chunk.toString("base64") },
      z.strictObject({ receivedBytes: z.number().int() }),
    );
    if (receipt.receivedBytes !== offset + chunk.length)
      throw new Error("Artifact import acknowledgment is inconsistent");
  }
}
