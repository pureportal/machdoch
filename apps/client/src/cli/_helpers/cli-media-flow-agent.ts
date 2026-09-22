import { readFile, stat } from "node:fs/promises";
import { loadRuntimeConfig } from "../../core/config.js";
import { runMediaFlowAgent } from "../../core/media/flow-agent.js";
import type { MediaFlowAgentRequest } from "@machdoch/media-studio/core/media/flow-agent.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

export async function runMediaFlowAgentCommand(
  args: ParsedCliArgs,
): Promise<void> {
  const path = args.mediaFlowAgent?.inputJsonFile;
  if (!path) throw new Error("Missing Media Studio assistant input.");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024)
    throw new Error("Media Studio assistant input exceeds 2 MiB.");
  const request = JSON.parse(
    await readFile(path, "utf8"),
  ) as MediaFlowAgentRequest;
  const config = await loadRuntimeConfig(args.workspaceRoot);
  writeStdoutLine(JSON.stringify(await runMediaFlowAgent(config, request)));
}
