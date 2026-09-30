import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RalphBlockExecutionResult } from "../ralph.js";

export const readRalphExecutionHistoryResults = async (
  paths: { recordPath: string } | undefined,
  limit = Number.POSITIVE_INFINITY,
): Promise<RalphBlockExecutionResult[]> => {
  if (!paths) {
    return [];
  }
  const historyPath = join(
    dirname(paths.recordPath),
    "execution-history.jsonl",
  );
  let handle;
  try {
    handle = await open(historyPath, "r");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw new Error(
      `Could not read Ralph execution history at ${historyPath}: ${String(error)}`,
      { cause: error },
    );
  }
  const results: RalphBlockExecutionResult[] = [];
  const seen = new Set<string>();
  let index = 0;
  try {
    const size = (await handle.stat()).size;
    const finalByte = Buffer.alloc(1);
    if (size > 0) {
      await handle.read(finalByte, 0, 1, size - 1);
    }
    const hasTerminatingNewline = size === 0 || finalByte[0] === 10;
    let pending: string | undefined;
    const append = (line: string, partialTail: boolean): void => {
      index += 1;
      if (!line.trim()) {
        return;
      }
      try {
        const entry = JSON.parse(line) as {
          kind?: string;
          result?: RalphBlockExecutionResult;
        };
        const result =
          entry?.kind === "block-result" ? entry.result : undefined;
        if (
          !result ||
          typeof result.blockId !== "string" ||
          typeof result.output !== "string"
        ) {
          throw new Error("entry is not a Ralph block-result record");
        }
        const key =
          result.operationId ?? `${index}:${result.blockId}:${result.attempt}`;
        if (seen.has(key)) {
          return;
        }
        if (result.operationId) {
          seen.add(key);
        }
        results.push(result);
        if (results.length > limit) {
          const removed = results.shift();
          if (removed?.operationId) {
            seen.delete(removed.operationId);
          }
        }
      } catch (error) {
        if (!partialTail) {
          throw new Error(
            `Corrupt Ralph execution history at ${historyPath}:${index}: ${String(error)}`,
            { cause: error },
          );
        }
      }
    };
    for await (const line of handle.readLines()) {
      if (pending !== undefined) {
        append(pending, false);
      }
      pending = line;
    }
    if (pending !== undefined) {
      append(pending, !hasTerminatingNewline);
    }
    return results;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Corrupt Ralph execution history")
    ) {
      throw error;
    }
    throw new Error(
      `Could not read Ralph execution history at ${historyPath}: ${String(error)}`,
      { cause: error },
    );
  } finally {
    await handle.close();
  }
};
