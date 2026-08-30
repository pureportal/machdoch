import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "rolldown";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = resolve(projectRoot, "dist", "machdoch-cli.cjs");
const packageMetadata = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
const requireResolveShim = String.raw`
globalThis.__MACHDOCH_PRODUCT_VERSION__ = ${JSON.stringify(packageMetadata.version)};
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
