import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/cli/main.ts"],
  format: "cjs",
  logLevel: "info",
  outfile: "dist/machdoch-cli.cjs",
  platform: "node",
  sourcemap: true,
  target: "node20.10",
});
