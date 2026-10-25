import { build, loadConfigFromFile, mergeConfig } from "vite";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(app, "../../.tmp/cloud-desktop-ui");
const output = join(directory, randomUUID());
const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  join(app, "vite.ui.config.ts"),
);
if (!loaded) throw new Error("Client UI build configuration is unavailable");
await build(
  mergeConfig(loaded.config, {
    configFile: false,
    root: join(app, "scripts"),
    logLevel: "warn",
    build: {
      outDir: output,
      emptyOutDir: false,
      rollupOptions: {
        input: join(app, "scripts/cloud-workspace-fixture.html"),
      },
    },
  }),
);
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, "current.json"),
  JSON.stringify({ directory: output }),
);
process.stdout.write(`Cloud UI fixture: ${output}\n`);
