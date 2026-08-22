import process from "node:process";
import { MAX_TASK_INPUT_BYTES } from "../../shared/task-input-limits.js";

export const MAX_STDIN_TASK_BYTES = MAX_TASK_INPUT_BYTES;

export const readTaskFromStdin = async (
  input: NodeJS.ReadableStream = process.stdin,
  maxBytes = MAX_STDIN_TASK_BYTES,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > maxBytes) {
      throw new Error(
        `Task input from stdin exceeds the ${maxBytes}-byte limit.`,
      );
    }
    chunks.push(bytes);
  }

  let task: string;
  try {
    task = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, byteLength),
    );
  } catch {
    throw new Error("Task input from stdin must be valid UTF-8.");
  }

  const normalized = task.trim();
  if (!normalized) {
    throw new Error("Task input from stdin is empty.");
  }
  return normalized;
};
