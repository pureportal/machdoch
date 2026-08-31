import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  expectedDebianMaintainer,
  parseDebianPackagePaths,
  requiredDebianDependencies,
  requiredLinuxPackagePaths,
  requiredRpmDependencies,
  validateDebianPackage,
  validateGlibcBaseline,
  validateOnnxRuntimeRunpath,
  validateRpmPackage,
} from "./verify-linux-package.mjs";

const configuration = JSON.parse(
  await readFile(
    new URL("../../apps/client/src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);

test("accepts the expected ARM64 Debian metadata and paths", () => {
  assert.doesNotThrow(() =>
    validateDebianPackage({
      architecture: "arm64",
      configuration,
      contents: requiredLinuxPackagePaths
        .map((path) => `-rw-r--r-- root/root 0 ./usr${path.slice(4)}`)
        .join("\n"),
      fields: {
        package: "machdoch",
        version: configuration.version,
        architecture: "arm64",
        homepage: configuration.bundle.homepage,
        maintainer: expectedDebianMaintainer,
        description: `${configuration.bundle.shortDescription}\n ${configuration.bundle.longDescription}`,
        depends: requiredDebianDependencies
          .map((dependency) => `${dependency} (>= 1)`)
          .join(", "),
        recommends: "python3-nautilus",
      },
    }),
  );
});

test("parses Debian archive paths produced by Tauri", () => {
  assert.deepEqual(
    parseDebianPackagePaths(
      [
        "-rwxr-xr-x root/root 0 2026-08-31 09:39 usr/bin/machdoch",
        "-rw-r--r-- root/root 0 2026-08-31 09:39 ./usr/share/applications/machdoch.desktop",
      ].join("\n"),
    ),
    ["/usr/bin/machdoch", "/usr/share/applications/machdoch.desktop"],
  );
});

test("rejects a Debian package with the legacy tray dependency", () => {
  assert.throws(
    () =>
      validateDebianPackage({
        architecture: "amd64",
        configuration,
        contents: requiredLinuxPackagePaths
          .map((path) => `-rw-r--r-- root/root 0 .${path}`)
          .join("\n"),
        fields: {
          package: "machdoch",
          version: configuration.version,
          architecture: "amd64",
          homepage: configuration.bundle.homepage,
          maintainer: expectedDebianMaintainer,
          description: `${configuration.bundle.shortDescription}\n ${configuration.bundle.longDescription}`,
          depends: requiredDebianDependencies
            .map((dependency) =>
              dependency === "libayatana-appindicator3-1"
                ? "libappindicator3-1"
                : dependency,
            )
            .join(", "),
          recommends: "python3-nautilus",
        },
      }),
    /libayatana-appindicator3-1/u,
  );
});

test("accepts the expected x86_64 RPM metadata and paths", () => {
  assert.doesNotThrow(() =>
    validateRpmPackage({
      architecture: "x86_64",
      configuration,
      dependencies: requiredRpmDependencies,
      fields: {
        name: "machdoch",
        version: configuration.version,
        architecture: "x86_64",
        homepage: configuration.bundle.homepage,
        summary: configuration.bundle.shortDescription,
        description: configuration.bundle.longDescription,
      },
      packagePaths: requiredLinuxPackagePaths,
      recommendations: ["nautilus-python"],
    }),
  );
});

test("enforces the Debian 12 glibc baseline", () => {
  assert.doesNotThrow(() =>
    validateGlibcBaseline("Name: GLIBC_2.34 Name: GLIBC_2.36", "2.36"),
  );
  assert.throws(
    () => validateGlibcBaseline("Name: GLIBC_2.39", "2.36"),
    /requires glibc 2\.39/u,
  );
});

test("requires the bundled ONNX Runtime library path", () => {
  assert.doesNotThrow(() =>
    validateOnnxRuntimeRunpath(
      "0x000000000000001d (RUNPATH) Library runpath: [$ORIGIN/../lib/machdoch]",
    ),
  );
  assert.throws(
    () => validateOnnxRuntimeRunpath("0x000000000000001d (RUNPATH) []"),
    /bundled ONNX Runtime/u,
  );
});
