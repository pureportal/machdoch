import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalInstallerNames,
  findSupersededInstallerNames,
  prepareReleaseAssets,
  validateConfiguredBundleTargets,
  validatePublishedInstallerNames,
} from "./release-assets.mjs";

async function createTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "machdoch-release-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeBundle(bundleDirectory, directory, name, contents) {
  const targetDirectory = join(bundleDirectory, directory);
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(targetDirectory, name), contents);
}

test("prepares one canonical Linux asset for every installer type", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(t);
  const bundleDirectory = join(temporaryDirectory, "bundle");
  const outputDirectory = join(temporaryDirectory, "release-assets");

  await writeBundle(bundleDirectory, "deb", "machdoch_2.2.0_amd64.deb", "deb");
  await writeBundle(
    bundleDirectory,
    "rpm",
    "machdoch-2.2.0-1.x86_64.rpm",
    "rpm",
  );
  await writeBundle(
    bundleDirectory,
    "appimage",
    "machdoch_2.2.0_amd64.AppImage",
    "appimage",
  );

  const paths = await prepareReleaseAssets({
    platform: "linux",
    bundleDirectory,
    outputDirectory,
  });

  assert.deepEqual(
    paths.map((path) => path.split(/[\\/]/u).at(-1)),
    [
      "machdoch-linux-amd64.deb",
      "machdoch-linux-x86_64.rpm",
      "machdoch-linux-amd64.AppImage",
    ],
  );
  assert.equal(
    await readFile(join(outputDirectory, "machdoch-linux-amd64.deb"), "utf8"),
    "deb",
  );
  assert.equal(
    await readFile(join(outputDirectory, "machdoch-linux-x86_64.rpm"), "utf8"),
    "rpm",
  );
  assert.equal(
    await readFile(
      join(outputDirectory, "machdoch-linux-amd64.AppImage"),
      "utf8",
    ),
    "appimage",
  );
});

test("prepares one canonical Windows asset for every installer type", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(t);
  const bundleDirectory = join(temporaryDirectory, "bundle");
  const outputDirectory = join(temporaryDirectory, "release-assets");

  await writeBundle(
    bundleDirectory,
    "msi",
    "machdoch_2.2.0_x64_en-US.msi",
    "msi",
  );
  await writeBundle(
    bundleDirectory,
    "nsis",
    "machdoch_2.2.0_x64-setup.exe",
    "nsis",
  );

  const paths = await prepareReleaseAssets({
    platform: "windows",
    bundleDirectory,
    outputDirectory,
  });

  assert.deepEqual(
    paths.map((path) => path.split(/[\\/]/u).at(-1)),
    ["machdoch-windows-x64.msi", "machdoch-windows-x64-setup.exe"],
  );
  assert.equal(
    await readFile(join(outputDirectory, "machdoch-windows-x64.msi"), "utf8"),
    "msi",
  );
  assert.equal(
    await readFile(
      join(outputDirectory, "machdoch-windows-x64-setup.exe"),
      "utf8",
    ),
    "nsis",
  );
});

test("rejects multiple bundles for the same installer type", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(t);
  const bundleDirectory = join(temporaryDirectory, "bundle");

  await writeBundle(
    bundleDirectory,
    "msi",
    "machdoch_2.2.0_x64_en-US.msi",
    "first",
  );
  await writeBundle(
    bundleDirectory,
    "msi",
    "machdoch_2.2.1_x64_en-US.msi",
    "second",
  );
  await writeBundle(
    bundleDirectory,
    "nsis",
    "machdoch_2.2.0_x64-setup.exe",
    "nsis",
  );

  await assert.rejects(
    prepareReleaseAssets({
      platform: "windows",
      bundleDirectory,
      outputDirectory: join(temporaryDirectory, "release-assets"),
    }),
    /Expected exactly one MSI bundle/u,
  );
});

test("accepts exactly the canonical installer asset set", () => {
  const nonInstallerAssets = [
    "Source code (zip)",
    "Source code (tar.gz)",
    "sbom-ubuntu.spdx.json",
  ];

  assert.doesNotThrow(() =>
    validatePublishedInstallerNames(
      [...canonicalInstallerNames, ...nonInstallerAssets],
      "2.2.0",
    ),
  );
  assert.deepEqual(
    findSupersededInstallerNames(nonInstallerAssets, "2.2.0"),
    [],
  );
});

test("maps every supported Tauri bundle target to one canonical asset", () => {
  const targets = ["msi", "nsis", "deb", "rpm", "appimage"];

  assert.doesNotThrow(() => validateConfiguredBundleTargets(targets));
  assert.equal(new Set(canonicalInstallerNames).size, targets.length);
});

test("identifies and rejects versioned installer duplicates", () => {
  const versionedNames = [
    "machdoch_2.2.0_x64_en-US.msi",
    "machdoch_2.2.0_x64-setup.exe",
    "machdoch_2.2.0_amd64.deb",
    "machdoch-2.2.0-1.x86_64.rpm",
    "machdoch_2.2.0_amd64.AppImage",
  ];

  assert.deepEqual(
    findSupersededInstallerNames(
      [...canonicalInstallerNames, ...versionedNames],
      "2.2.0",
    ),
    versionedNames.toSorted((left, right) => left.localeCompare(right)),
  );
  assert.throws(
    () =>
      validatePublishedInstallerNames(
        [...canonicalInstallerNames, ...versionedNames],
        "2.2.0",
      ),
    /contain version 2\.2\.0/u,
  );
});

test("does not classify a distinct non-versioned platform asset as superseded", () => {
  assert.deepEqual(
    findSupersededInstallerNames(
      [...canonicalInstallerNames, "machdoch-linux-arm64.deb"],
      "2.2.0",
    ),
    [],
  );
});
