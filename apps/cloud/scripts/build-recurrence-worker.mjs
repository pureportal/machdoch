import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  cwd: project,
  input: "src/server/cloud/automation/recurrence-worker.ts",
  platform: "node",
  transform: { target: "node24" },
  output: {
    file: resolve(project, "dist/cloud-recurrence-worker.mjs"),
    format: "esm",
    codeSplitting: false,
  },
});
