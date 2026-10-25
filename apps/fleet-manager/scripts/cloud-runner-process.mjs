import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export async function startRunnerProcess(
  fixture,
  worker,
  sandbox,
  name,
  { once: onceOnly = true, repairAttempts = 1 } = {},
) {
  const stateDirectory = join(fixture.directory, name);
  await mkdir(stateDirectory, { recursive: true });
  const path = join(stateDirectory, "runner.json");
  await writeFile(
    path,
    JSON.stringify({
      origin: fixture.origin,
      stateDirectory,
      repairAttempts,
      sandbox: { backend: "whpx", ...sandbox },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "@oxc-node/core/register",
      fileURLToPath(new URL("../../cloud-runner/src/main.ts", import.meta.url)),
      "--config",
      path,
      ...(onceOnly ? ["--once"] : []),
    ],
    {
      cwd: fileURLToPath(new URL("../../cloud-runner/", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        MACHDOCH_CLOUD_RUNNER_TOKEN: worker.token,
        NODE_EXTRA_CA_CERTS: join(fixture.directory, "tls.crt"),
      },
    },
  );
  let output = "";
  child.stdout.on("data", (bytes) => {
    output = (output + bytes).slice(-16000);
  });
  child.stderr.on("data", (bytes) => {
    output = (output + bytes).slice(-16000);
  });
  const timer = setTimeout(() => child.kill(), 210000);
  child.finished = once(child, "exit").finally(() => clearTimeout(timer));
  child.logs = () => output;
  child.stateDirectory = stateDirectory;
  return child;
}
export function runnerHistory(child) {
  const database = new DatabaseSync(
    join(child.stateDirectory, "runner.sqlite"),
  );
  try {
    assert.equal(
      database.prepare("SELECT job FROM runner_state").get().job,
      null,
    );
    return JSON.parse(
      database
        .prepare(
          "SELECT job FROM runner_history ORDER BY sequence DESC LIMIT 1",
        )
        .get().job,
    );
  } finally {
    database.close();
  }
}
