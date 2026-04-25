import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = resolve(projectRoot, "dist", "machdoch-cli.cjs");

await mkdir(dirname(outputFile), { recursive: true });

await build({
  absWorkingDir: projectRoot,
  bundle: true,
  entryPoints: ["src/cli/main.ts"],
  format: "cjs",
  logLevel: "info",
  outfile: outputFile,
  platform: "node",
  sourcemap: true,
  target: "node20.10",
});
