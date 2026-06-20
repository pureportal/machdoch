import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

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
  absWorkingDir: projectRoot,
  banner: {
    js: requireResolveShim,
  },
  bundle: true,
  entryPoints: ["src/cli/main.ts"],
  external: ["playwright-core"],
  format: "cjs",
  logLevel: "info",
  outfile: outputFile,
  platform: "node",
  sourcemap: true,
  target: "node20.10",
});
