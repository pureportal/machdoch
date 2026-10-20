import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { c as createTar } from "tar";

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

test("Windows packaging uses the system archive extractor with absolute drive paths", { skip: process.platform !== "win32" }, async () => {
  const temporaryRoot = resolve(import.meta.dirname, "../../../.tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const fixture = await mkdtemp(join(temporaryRoot, "drama3-windows-packaging-"));
  try {
    const scripts = join(fixture, "scripts");
    const resources = join(fixture, "src-tauri/resources/speech");
    const inputs = join(fixture, "inputs");
    await Promise.all([mkdir(scripts), mkdir(resources, { recursive: true }), mkdir(inputs)]);
    for (const name of ["prepare-drama3.mjs", "download-verified-asset.mjs"]) {
      await copyFile(join(import.meta.dirname, name), join(scripts, name));
    }
    await writeFile(join(inputs, "audiocpp_cli.exe"), "fixture engine");
    await writeFile(join(inputs, "LICENSE"), "fixture license");
    const archive = join(resources, "drama3.zip");
    await createTar({ file: archive, cwd: inputs }, ["audiocpp_cli.exe", "LICENSE"]);
    const bytes = await readFile(archive);
    await writeFile(join(scripts, "drama3-assets.json"), JSON.stringify({ version: "fixture", platforms: {
      [`win32-${process.arch}`]: { url: "https://invalid.test/no-network", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    } }));
    execFileSync(process.execPath, [join(scripts, "prepare-drama3.mjs")], {
      env: { ...process.env, PATH: scripts }, stdio: "pipe", windowsHide: true,
    });
    const inventory = JSON.parse(await readFile(join(resources, "drama3/runtime.json"), "utf8"));
    assert.equal(inventory.version, "fixture");
    assert.equal(await readFile(join(resources, "drama3/audiocpp_cli.exe"), "utf8"), "fixture engine");
    assert.deepEqual(Object.keys(inventory.files).sort(), ["LICENSE", "audiocpp_cli.exe"]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
