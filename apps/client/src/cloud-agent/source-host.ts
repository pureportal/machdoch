import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { readStartupInput } from "./startup-input.js";
import { sourcePackRequestSchema } from "../core/cloud/source-pack-contract.js";
import {
  spawnWindowsContainer,
  windowsClientSandboxRequest,
} from "../core/cloud/windows-sandbox.js";

async function main(): Promise<void> {
  const initial = await readStartupInput();
  if (initial.remainder.length)
    throw new Error("Unexpected source export input.");
  const input = sourcePackRequestSchema.parse(initial.message);
  const request = await windowsClientSandboxRequest({
    access: "read-only",
    executable: input.gitExecutable,
    arguments: [
      `--git-dir=${input.repositoryDirectory}`,
      "pack-objects",
      "--stdout",
      "--revs",
      "--shallow",
      "--threads=1",
      "--window-memory=16777216",
      "--no-use-bitmap-index",
    ],
    checkoutDirectory: input.repositoryDirectory,
    stateDirectory: input.stateDirectory,
    readonlyPaths: [dirname(input.gitExecutable), input.objectDirectory],
    durationMs: 55000,
  });
  request.environment = {
    ...request.environment,
    PATH: dirname(input.gitExecutable),
    GIT_OBJECT_DIRECTORY: input.objectDirectory,
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_CONFIG_SYSTEM: "NUL",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const child = await spawnWindowsContainer(request);
  try {
    if (!child.standardOutput || !child.standardError || !child.standardInput)
      throw new Error("The source export process did not provide its streams.");
    child.standardInput.end(input.baseCommit + "\n");
    const [result] = await Promise.all([
      child.wait(),
      pipeline(child.standardOutput, process.stdout, { end: false }),
      pipeline(child.standardError, process.stderr, { end: false }),
    ]);
    process.exitCode = result.exitCode === 0 && !result.timedOut ? 0 : 1;
  } finally {
    child.dispose();
    process.stdin.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Source export failed."}\n`,
  );
  process.stdin.destroy();
  process.exitCode = 1;
});
