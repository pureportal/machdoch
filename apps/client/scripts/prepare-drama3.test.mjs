import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("unsupported release architectures package without a local Drama 3 engine", async () => {
  const temporaryRoot = resolve(import.meta.dirname, "../../../.tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const fixture = await mkdtemp(join(temporaryRoot, "drama3-packaging-"));
  try {
    const scripts = join(fixture, "scripts");
    await mkdir(scripts);
    for (const name of ["prepare-drama3.mjs", "drama3-assets.json", "download-verified-asset.mjs"]) {
      await copyFile(join(import.meta.dirname, name), join(scripts, name));
    }
    const entrypoint = pathToFileURL(join(scripts, "prepare-drama3.mjs")).href;
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "arm64" });
      await import(${JSON.stringify(entrypoint)});
    `], { stdio: "pipe", windowsHide: true });
    const inventory = JSON.parse(await readFile(join(fixture, "src-tauri/resources/speech/drama3/runtime.json"), "utf8"));
    assert.equal(inventory.platform, "linux-arm64");
    assert.equal(inventory.supported, false);
    assert.deepEqual(inventory.files, {});
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
