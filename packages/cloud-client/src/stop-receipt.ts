import { z } from "zod";
import { open } from "node:fs/promises";

export const stopReceiptSchema = z.strictObject({
  version: z.literal(1),
  environmentId: z.uuid(),
  supervisorPid: z.number().int().positive(),
  childPid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  reason: z.enum([
    "completed",
    "canceled",
    "lease_expired",
    "parent_closed",
    "control_error",
    "start_expired",
  ]),
  processTreeStopped: z.literal(true),
});
export type StopReceipt = z.infer<typeof stopReceiptSchema>;
export const environmentLifecycleSchema = z.strictObject({
  directory: z.string().min(1),
  environmentId: z.uuid(),
});
export async function readStopReceipt(
  path: string,
  environmentId: string,
): Promise<StopReceipt | null> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Environment receipt is not a regular file");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096)
      throw new Error("Environment receipt exceeds its size limit");
    const receipt = stopReceiptSchema.parse(
      JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
    );
    if (receipt.environmentId !== environmentId)
      throw new Error("Environment receipt belongs to another environment");
    return receipt;
  } finally {
    await file.close();
  }
}
