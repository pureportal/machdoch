import type { RunMode } from "../../core/runtime-contract.generated.js";
import type { ChatInput } from "./cli-chat-input.js";
import { CliUsageError } from "./cli-error.js";

export const readPastedTask = async (
  input: ChatInput,
  mode?: string,
): Promise<{ task: string; mode?: RunMode } | undefined> => {
  if (mode !== undefined && mode !== "ask" && mode !== "machdoch")
    throw new CliUsageError("Usage: /paste [ask|machdoch]");
  const lines: string[] = [];
  while (true) {
    const line = await input.readLine("paste> ");
    if (!line || line.text.trim() === "/cancel") return undefined;
    if (line.text.trim() === "/end") {
      const task = lines.join("\n").trim();
      return task ? { task, ...(mode ? { mode } : {}) } : undefined;
    }
    lines.push(line.text);
  }
};
