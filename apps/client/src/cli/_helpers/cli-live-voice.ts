import { resolve } from "node:path";
import { runLiveVoiceRequest } from "../../core/live-voice.js";
import { readStableRegularFile } from "../../core/_helpers/read-stable-regular-file.helper.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

export async function runLiveVoiceCommand(args: ParsedCliArgs): Promise<void> {
  let request = args.liveVoice?.request;
  if (args.liveVoice?.inputJsonFile) {
    const bytes = await readStableRegularFile(resolve(args.workspaceRoot, args.liveVoice.inputJsonFile), { maxBytes: 128_000 });
    if (!bytes) throw new Error("The live voice request file does not exist.");
    request = JSON.parse(bytes.toString("utf8"));
  }
  writeStdoutLine(JSON.stringify(await runLiveVoiceRequest(args.workspaceRoot, request)));
}
