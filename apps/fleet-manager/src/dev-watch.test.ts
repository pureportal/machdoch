import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import packageJson from "../package.json";

it("restarts Fleet for source edits without restarting for access times or generated files", async () => {
  const temporaryRoot = resolve(import.meta.dirname, "../../../.tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const fixtureParent = realpathSync(temporaryRoot);
  const directory = mkdtempSync(join(fixtureParent, "fleet-watch-"));
  const sourcePaths = [
    "src/server.ts",
    "src/server/config.ts",
    "src/server/migrations/001-initial.sql",
    "next.config.ts",
  ];
  const sourceTime = new Date(Date.now() - 86_400_000);
  sourceTime.setMilliseconds(0);
  for (const path of sourcePaths) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), "");
  }
  writeFileSync(
    join(directory, "src/server.ts"),
    `import { readFileSync } from "node:fs";
for (const path of ${JSON.stringify(sourcePaths)}) readFileSync(path);
console.log("fleet-watch-fixture:" + process.argv[2]);
`,
  );
  for (const path of sourcePaths) {
    utimesSync(join(directory, path), sourceTime, sourceTime);
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      type: "module",
      nodemonConfig: packageJson.nodemonConfig,
    }),
  );

  const monitor = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("nodemon/bin/nodemon.js")),
      ...packageJson.scripts.dev.split(" ").slice(1),
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const closed = once(monitor, "close");
  let output = "";
  monitor.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  monitor.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const completedRuns = (): number =>
    output.match(/clean exit - waiting for changes before restart/g)?.length ??
    0;

  try {
    await expect.poll(completedRuns, { timeout: 10_000 }).toBe(1);
    expect(output).toContain("fleet-watch-fixture:dev");

    for (const path of sourcePaths) {
      const filename = join(directory, path);
      const modified = statSync(filename).mtime;
      utimesSync(filename, new Date(), modified);
      readFileSync(filename);
      expect(statSync(filename).mtime).toEqual(modified);
    }
    for (const path of [
      ".next/dev/server/generated.js",
      "data/fleet-manager.sqlite",
      "src/app/page.tsx",
    ]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), "generated");
    }
    await delay(800);
    expect(completedRuns(), output).toBe(1);

    for (const [index, path] of sourcePaths.entries()) {
      appendFileSync(join(directory, path), "\n");
      await expect.poll(completedRuns, { timeout: 10_000 }).toBe(index + 2);
    }
    await delay(800);
    expect(completedRuns(), output).toBe(sourcePaths.length + 1);
  } finally {
    monitor.kill();
    await closed;
    expect(dirname(realpathSync(directory))).toBe(fixtureParent);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
