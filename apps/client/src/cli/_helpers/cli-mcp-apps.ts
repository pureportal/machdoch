import { resolve } from "node:path";
import { runMcpAppRequest } from "../../core/mcp/apps.js";
import { readStableRegularFile } from "../../core/_helpers/read-stable-regular-file.helper.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

export async function runMcpAppsCommand(args: ParsedCliArgs): Promise<void> {
  let request = args.mcpApps?.request;
  if (args.mcpApps?.inputJsonFile) {
    const content = await readStableRegularFile(resolve(args.workspaceRoot, args.mcpApps.inputJsonFile), { maxBytes: 2 * 1024 * 1024 });
    if (!content) throw new Error("The MCP App request file does not exist.");
    request = JSON.parse(content.toString("utf8"));
  }
  writeStdoutLine(JSON.stringify(await runMcpAppRequest(args.workspaceRoot, request), null, args.json ? undefined : 2));
}
