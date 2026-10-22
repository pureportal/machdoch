import { resolve } from "node:path";
import { runWorkspaceLibraryRequest } from "../../core/workspace-library/index.js";
import { readStableRegularFile } from "../../core/_helpers/read-stable-regular-file.helper.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

export async function runWorkspaceLibraryCommand(args: ParsedCliArgs): Promise<void> {
  let request = args.workspaceLibrary?.request;
  if (args.workspaceLibrary?.inputJsonFile) {
    const content = await readStableRegularFile(resolve(args.workspaceRoot, args.workspaceLibrary.inputJsonFile), { maxBytes: 2 * 1024 * 1024 });
    if (!content) throw new Error("The workspace library request file does not exist.");
    request = JSON.parse(content.toString("utf8"));
  }
  writeStdoutLine(JSON.stringify(await runWorkspaceLibraryRequest(args.workspaceRoot, request), null, args.json ? undefined : 2));
}
