import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function startCloudWorkflowWorker(fixture, temporal, installationId) {
  const child = spawn(
    process.execPath,
    ["--import", "@oxc-node/core/register", "scripts/cloud-workflows.ts"],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      windowsHide: true,
      env: {
        ...process.env,
        ...fixture.environment,
        MACHDOCH_CLOUD_TEMPORAL_ADDRESS: temporal.address,
        MACHDOCH_CLOUD_TEMPORAL_NAMESPACE: temporal.namespace,
        MACHDOCH_CLOUD_INSTALLATION_ID: installationId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-20000);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-20000);
  });
  child.finished = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  child.logs = () => output;
  return child;
}
