import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile } from "node:fs/promises";
import { build } from "rolldown";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const [entry, output] of [
  ["main", "machdoch-cloud-agent"],
  ["sandbox-host", "machdoch-cloud-sandbox"],
  ["source-host", "machdoch-cloud-source"],
])
  await build({
    cwd: project,
    input: `src/cloud-agent/${entry}.ts`,
    external: ["playwright-core", "@microsoft/mxc-sdk/v1"],
    platform: "node",
    transform: { target: "node24" },
    tsconfig: resolve(project, "tsconfig.json"),
    output: {
      file: resolve(project, `dist/${output}.cjs`),
      format: "cjs",
      codeSplitting: false,
      sourcemap: true,
    },
  });
await copyFile(
  resolve(project, "src/cloud-agent/windows-volume.ps1"),
  resolve(project, "dist/machdoch-cloud-volume.ps1"),
);
