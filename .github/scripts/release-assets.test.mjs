import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalInstallerNames,
  findSupersededInstallerNames,
  installerAssetDefinitions,
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

test("prepares canonical amd64 Linux assets", async (t) => {
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
    releaseTarget: "linux-amd64",
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

test("prepares the canonical ARM64 Debian asset", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(t);
  const bundleDirectory = join(temporaryDirectory, "bundle");
  const outputDirectory = join(temporaryDirectory, "release-assets");

  await writeBundle(
    bundleDirectory,
    "deb",
    "machdoch_2.2.0_arm64.deb",
    "arm64-deb",
  );

  const paths = await prepareReleaseAssets({
    releaseTarget: "linux-arm64",
    bundleDirectory,
    outputDirectory,
  });

  assert.deepEqual(
    paths.map((path) => path.split(/[\\/]/u).at(-1)),
    ["machdoch-linux-arm64.deb"],
  );
  assert.equal(
    await readFile(join(outputDirectory, "machdoch-linux-arm64.deb"), "utf8"),
    "arm64-deb",
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
    releaseTarget: "windows-x64",
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
      releaseTarget: "windows-x64",
      bundleDirectory,
      outputDirectory: join(temporaryDirectory, "release-assets"),
    }),
    /Expected exactly one x64 MSI bundle/u,
  );
});

test("rejects ARM64 Windows bundles for the x64 release target", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(t);
  const bundleDirectory = join(temporaryDirectory, "bundle");

  await writeBundle(
    bundleDirectory,
    "msi",
    "machdoch_2.2.0_arm64_en-US.msi",
    "arm64-msi",
  );
  await writeBundle(
    bundleDirectory,
    "nsis",
    "machdoch_2.2.0_x64-setup.exe",
    "x64-nsis",
  );

  await assert.rejects(
    prepareReleaseAssets({
      releaseTarget: "windows-x64",
      bundleDirectory,
      outputDirectory: join(temporaryDirectory, "release-assets"),
    }),
    /Expected exactly one x64 MSI bundle/u,
  );
});

test("rejects an amd64 Debian bundle for the ARM64 release target", async (t) => {
  const temporaryDirectory = await createTemporaryDirectory(t);
  const bundleDirectory = join(temporaryDirectory, "bundle");

  await writeBundle(
    bundleDirectory,
    "deb",
    "machdoch_2.2.0_amd64.deb",
    "amd64-deb",
  );

  await assert.rejects(
    prepareReleaseAssets({
      releaseTarget: "linux-arm64",
      bundleDirectory,
      outputDirectory: join(temporaryDirectory, "release-assets"),
    }),
    /Expected exactly one ARM64 Debian bundle/u,
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

test("requires the ARM64 Debian asset in a published release", () => {
  assert.throws(
    () =>
      validatePublishedInstallerNames(
        canonicalInstallerNames.filter(
          (name) => name !== "machdoch-linux-arm64.deb",
        ),
        "2.2.0",
      ),
    /missing: machdoch-linux-arm64\.deb/u,
  );
});

test("maps every supported Tauri bundle target to canonical assets", () => {
  const targets = ["msi", "nsis", "deb", "rpm", "appimage"];

  assert.doesNotThrow(() => validateConfiguredBundleTargets(targets));
  assert.equal(
    new Set(canonicalInstallerNames).size,
    installerAssetDefinitions.length,
  );
});

test("pins installer metadata, dependencies, and installation paths", async () => {
  const configuration = JSON.parse(
    await readFile(
      new URL("../../apps/client/src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const expectedLinuxFiles = {
    "/usr/share/kio/servicemenus/machdoch-folder-context.desktop":
      "linux/machdoch-folder-context.desktop",
    "/usr/share/kio/servicemenus/machdoch-files-context.desktop":
      "linux/machdoch-files-context.desktop",
    "/usr/share/nautilus-python/extensions/machdoch.py":
      "linux/machdoch_nautilus.py",
  };

  assert.equal(configuration.bundle.publisher, "machdoch");
  assert.equal(
    configuration.bundle.homepage,
    "https://github.com/pureportal/machdoch",
  );
  assert.equal(configuration.bundle.category, "Productivity");
  assert.equal(
    configuration.bundle.shortDescription,
    "Local-first OS AI agent for CLI and desktop.",
  );
  assert.equal(
    configuration.bundle.longDescription,
    "Machdoch is a local-first AI assistant for Windows and Linux that works with folders, runs tasks, and automates repeatable workflows from the desktop or CLI.",
  );
  assert.equal(
    configuration.bundle.windows.wix.upgradeCode,
    "47638e6f-1542-5d67-bc57-e5ae45db5fd8",
  );
  assert.equal(configuration.bundle.windows.nsis.installMode, "currentUser");
  assert.deepEqual(configuration.bundle.linux.deb.depends, [
    "libgbm1",
    "libpipewire-0.3-0",
  ]);
  assert.deepEqual(configuration.bundle.linux.deb.recommends, [
    "python3-nautilus",
  ]);
  assert.deepEqual(configuration.bundle.linux.deb.files, expectedLinuxFiles);
  assert.deepEqual(configuration.bundle.linux.rpm.depends, [
    "libgbm.so.1()(64bit)",
    "libpipewire-0.3.so.0()(64bit)",
  ]);
  assert.deepEqual(configuration.bundle.linux.rpm.recommends, [
    "nautilus-python",
  ]);
  assert.deepEqual(configuration.bundle.linux.rpm.files, expectedLinuxFiles);
});

test("identifies and rejects versioned installer duplicates", () => {
  const versionedNames = [
    "machdoch_2.2.0_x64_en-US.msi",
    "machdoch_2.2.0_x64-setup.exe",
    "machdoch_2.2.0_amd64.deb",
    "machdoch_2.2.0_arm64.deb",
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

test("does not classify a distinct non-versioned architecture asset as superseded", () => {
  assert.deepEqual(
    findSupersededInstallerNames(
      [...canonicalInstallerNames, "machdoch-linux-armhf.deb"],
      "2.2.0",
    ),
    [],
  );
});
