import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanDesktopBundles } from "./clean-desktop-bundles.mjs";

test("removes cached installers while preserving compiled artifacts", async (t) => {
  const workspaceDirectory = await mkdtemp(
    join(tmpdir(), "machdoch-clean-bundles-"),
  );
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  const releaseDirectory = join(workspaceDirectory, ".cache/rust/release");
  const bundleDirectory = join(releaseDirectory, "bundle/msi");
  await mkdir(bundleDirectory, { recursive: true });
  await writeFile(
    join(bundleDirectory, "machdoch_26.0.0_x64_en-US.msi"),
    "stale installer",
  );
  await writeFile(join(releaseDirectory, "machdoch.exe"), "compiled binary");

  await cleanDesktopBundles(".cache/rust", workspaceDirectory);

  assert.deepEqual(await readdir(releaseDirectory), ["machdoch.exe"]);
  assert.equal(
    await readFile(join(releaseDirectory, "machdoch.exe"), "utf8"),
    "compiled binary",
  );
});

test("allows a first build without an existing bundle directory", async (t) => {
  const workspaceDirectory = await mkdtemp(
    join(tmpdir(), "machdoch-clean-bundles-"),
  );
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));

  await cleanDesktopBundles("apps/client/src-tauri/target", workspaceDirectory);

  assert.deepEqual(await readdir(workspaceDirectory), []);
});

test("rejects missing targets and paths outside the workspace", async () => {
  await assert.rejects(
    cleanDesktopBundles(undefined, process.cwd()),
    /target directory is required/u,
  );
  await assert.rejects(
    cleanDesktopBundles("../../outside", process.cwd()),
    /outside the workspace/u,
  );
});
