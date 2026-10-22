import { resolve } from "node:path";
import { runManagedSkillsRequest } from "../../core/managed-skills.js";
import { readStableRegularFile } from "../../core/_helpers/read-stable-regular-file.helper.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

export async function runSkillsCommand(args: ParsedCliArgs): Promise<void> {
  let request = args.skills?.request;
  if (args.skills?.inputJsonFile) {
    const content = await readStableRegularFile(resolve(args.workspaceRoot, args.skills.inputJsonFile), { maxBytes: 2 * 1024 * 1024 });
    if (!content) throw new Error("The skill request file does not exist.");
    request = JSON.parse(content.toString("utf8"));
  }
  writeStdoutLine(JSON.stringify(await runManagedSkillsRequest(request), null, args.json ? undefined : 2));
}
