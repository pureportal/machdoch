import {
  spawnWindowsClientSandbox,
  windowsClientSandboxInputSchema,
} from "../core/cloud/windows-sandbox.js";

import { readStartupInput } from "./startup-input.js";

async function main(): Promise<void> {
  const initial = await readStartupInput();
  const child = await spawnWindowsClientSandbox(
    windowsClientSandboxInputSchema.parse(initial.message),
  );
  try {
    if (!child.standardInput || !child.standardOutput || !child.standardError)
      throw new Error(
        "The client sandbox did not provide its process streams.",
      );
    child.standardOutput.pipe(process.stdout);
    child.standardError.pipe(process.stderr);
    process.stdout.write(JSON.stringify({ kind: "sandbox_ready" }) + "\n");
    if (initial.remainder.length) child.standardInput.write(initial.remainder);
    process.stdin.pipe(child.standardInput);
    const result = await child.wait();
    process.exitCode = result.exitCode === 0 && !result.timedOut ? 0 : 1;
  } finally {
    child.dispose();
    process.stdin.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Sandbox startup failed."}\n`,
  );
  process.stdin.destroy();
  process.exitCode = 1;
});
