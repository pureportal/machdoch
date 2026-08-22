import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "rolldown";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = resolve(projectRoot, "dist", "machdoch-cli.cjs");
const requireResolveShim = String.raw`
const __machdochRequireResolve = require.resolve.bind(require);
require.resolve = (request, options) => {
  if (request === "../../../package.json") {
    return __filename;
  }

  return __machdochRequireResolve(request, options);
};
`;

await mkdir(dirname(outputFile), { recursive: true });

await build({
  cwd: projectRoot,
  external: ["playwright-core"],
  input: "src/cli/main.ts",
  logLevel: "info",
  output: {
    banner: requireResolveShim,
    codeSplitting: false,
    file: outputFile,
    format: "cjs",
    minify: false,
    sourcemap: true,
  },
  platform: "node",
  transform: {
    target: "node22.13",
  },
  tsconfig: resolve(projectRoot, "tsconfig.json"),
});
