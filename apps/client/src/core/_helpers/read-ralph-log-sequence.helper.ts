import { open } from "node:fs/promises";
import type { RalphRunLogPaths } from "./create-ralph-storage-paths.helper.js";

const readLogSequence = async (path: string): Promise<number> => {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let maximum = 0;
  try {
    for await (const line of handle.readLines()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "sequence" in value &&
        typeof value.sequence === "number" &&
        Number.isSafeInteger(value.sequence)
      ) {
        maximum = Math.max(maximum, value.sequence);
      }
    }
    return maximum;
  } finally {
    await handle.close();
  }
};

export const readLastRalphLogSequence = async (
  paths: Pick<RalphRunLogPaths, "simpleJsonlPath" | "traceJsonlPath">,
): Promise<number> => {
  const sequences = await Promise.all([
    readLogSequence(paths.simpleJsonlPath),
    readLogSequence(paths.traceJsonlPath),
  ]);
  return Math.max(...sequences);
};
