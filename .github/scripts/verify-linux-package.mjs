import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredDebianDependencies = [
  "libayatana-appindicator3-1",
  "libgbm1",
  "libgtk-3-0",
  "libpipewire-0.3-0",
  "libwebkit2gtk-4.1-0",
];

export const expectedDebianMaintainer =
  "Andreas Ehrhardt <a.ehrhardt@alphartis.com>";

export const requiredRpmDependencies = [
  "libayatana-appindicator3.so.1()(64bit)",
  "libgbm.so.1()(64bit)",
  "libgtk-3.so.0()(64bit)",
  "libpipewire-0.3.so.0()(64bit)",
  "libwebkit2gtk-4.1.so.0()(64bit)",
];

export const requiredLinuxPackagePaths = [
  "/usr/bin/machdoch",
  "/usr/lib/machdoch/libonnxruntime.so.1",
  "/usr/lib/machdoch/python/build_source_anchored_loop.py",
  "/usr/lib/machdoch/python/media_diffusers_requirements.txt",
  "/usr/lib/machdoch/python/media_diffusers_worker.py",
  "/usr/share/applications/machdoch.desktop",
  "/usr/share/kio/servicemenus/machdoch-files-context.desktop",
  "/usr/share/kio/servicemenus/machdoch-folder-context.desktop",
  "/usr/share/nautilus-python/extensions/machdoch.py",
];

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must be ${expected}; found ${actual || "empty"}.`,
    );
  }
}

function assertIncludesAll(actualValues, expectedValues, label) {
  const missingValues = expectedValues.filter(
    (expectedValue) => !actualValues.includes(expectedValue),
  );

  if (missingValues.length > 0) {
    throw new Error(`${label} are missing: ${missingValues.join(", ")}.`);
  }
}

function packageMetadata(configuration) {
  const metadata = {
    name: configuration?.productName,
    version: configuration?.version,
    homepage: configuration?.bundle?.homepage,
    shortDescription: configuration?.bundle?.shortDescription,
    longDescription: configuration?.bundle?.longDescription,
  };

  for (const [name, value] of Object.entries(metadata)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Tauri package metadata is missing ${name}.`);
    }
  }

  return metadata;
}

export function parseDebianRelationshipNames(value) {
  return value
    .split(/[|,]/u)
    .map((relationship) => relationship.trim().split(/[\s(]/u, 1)[0])
    .map((name) => name.replace(/:(?:any|native)$/u, ""))
    .filter(Boolean);
}

export function parseDebianPackagePaths(contents) {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u).at(-1) ?? "")
    .filter((path) => path.startsWith("./"))
    .map((path) => path.slice(1));
}

export function validateDebianPackage({
  architecture,
  configuration,
  contents,
  fields,
}) {
  const metadata = packageMetadata(configuration);
  const descriptionLines = fields.description.split(/\r?\n/u);
  const dependencies = parseDebianRelationshipNames(fields.depends);
  const recommends = parseDebianRelationshipNames(fields.recommends);
  const packagePaths = parseDebianPackagePaths(contents);

  assertEqual(fields.package, metadata.name, "Debian package name");
  assertEqual(fields.version, metadata.version, "Debian package version");
  assertEqual(fields.architecture, architecture, "Debian package architecture");
  assertEqual(fields.homepage, metadata.homepage, "Debian package homepage");
  assertEqual(
    fields.maintainer,
    expectedDebianMaintainer,
    "Debian package maintainer",
  );
  assertEqual(
    descriptionLines[0],
    metadata.shortDescription,
    "Debian package summary",
  );

  if (!fields.description.includes(metadata.longDescription)) {
    throw new Error(
      "Debian package description does not match Tauri metadata.",
    );
  }

  assertIncludesAll(
    dependencies,
    requiredDebianDependencies,
    "Debian package dependencies",
  );
  assertIncludesAll(
    recommends,
    ["python3-nautilus"],
    "Debian package recommendations",
  );
  assertIncludesAll(
    packagePaths,
    requiredLinuxPackagePaths,
    "Debian package paths",
  );
}

export function validateRpmPackage({
  architecture,
  configuration,
  dependencies,
  fields,
  packagePaths,
  recommendations,
}) {
  const metadata = packageMetadata(configuration);

  assertEqual(fields.name, metadata.name, "RPM package name");
  assertEqual(fields.version, metadata.version, "RPM package version");
  assertEqual(fields.architecture, architecture, "RPM package architecture");
  assertEqual(fields.homepage, metadata.homepage, "RPM package homepage");
  assertEqual(fields.summary, metadata.shortDescription, "RPM package summary");
  assertEqual(
    fields.description,
    metadata.longDescription,
    "RPM package description",
  );
  assertIncludesAll(
    dependencies,
    requiredRpmDependencies,
    "RPM package dependencies",
  );
  assertIncludesAll(
    recommendations,
    ["nautilus-python"],
    "RPM package recommendations",
  );
  assertIncludesAll(
    packagePaths,
    requiredLinuxPackagePaths,
    "RPM package paths",
  );
}

function versionParts(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function validateGlibcBaseline(versionInformation, maximumVersion) {
  const versions = [
    ...versionInformation.matchAll(/GLIBC_(\d+(?:\.\d+)*)/gu),
  ].map((match) => match[1]);

  if (versions.length === 0) {
    throw new Error("Linux executable does not declare a glibc requirement.");
  }

  const newestVersion = versions.toSorted(compareVersions).at(-1);

  if (compareVersions(newestVersion, maximumVersion) > 0) {
    throw new Error(
      `Linux executable requires glibc ${newestVersion}; maximum supported is ${maximumVersion}.`,
    );
  }
}

export function validateOnnxRuntimeRunpath(dynamicSection) {
  if (!dynamicSection.includes("$ORIGIN/../lib/machdoch")) {
    throw new Error(
      "Linux executable does not search the bundled ONNX Runtime library path.",
    );
  }
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function readDebianField(packagePath, field) {
  return run("dpkg-deb", ["--field", packagePath, field]);
}

function readRpmField(packagePath, field) {
  return run("rpm", ["-qp", "--queryformat", `%{${field}}`, packagePath]);
}

function verifyGlibcBaseline(packagePath, configuration) {
  const extractionDirectory = mkdtempSync(join(tmpdir(), "machdoch-deb-"));

  try {
    run("dpkg-deb", ["--extract", packagePath, extractionDirectory]);
    const executablePath = join(
      extractionDirectory,
      "usr",
      "bin",
      configuration.productName,
    );
    const onnxRuntimePath = join(
      extractionDirectory,
      "usr",
      "lib",
      configuration.productName,
      "libonnxruntime.so.1",
    );
    validateGlibcBaseline(
      run("readelf", ["--version-info", executablePath]),
      "2.36",
    );
    validateOnnxRuntimeRunpath(run("readelf", ["--dynamic", executablePath]));
    validateGlibcBaseline(
      run("readelf", ["--version-info", onnxRuntimePath]),
      "2.36",
    );
  } finally {
    rmSync(extractionDirectory, { recursive: true, force: true });
  }
}

function verifyDebianPackage(packagePath, architecture, configuration) {
  validateDebianPackage({
    architecture,
    configuration,
    contents: run("dpkg-deb", ["--contents", packagePath]),
    fields: {
      package: readDebianField(packagePath, "Package"),
      version: readDebianField(packagePath, "Version"),
      architecture: readDebianField(packagePath, "Architecture"),
      homepage: readDebianField(packagePath, "Homepage"),
      maintainer: readDebianField(packagePath, "Maintainer"),
      description: readDebianField(packagePath, "Description"),
      depends: readDebianField(packagePath, "Depends"),
      recommends: readDebianField(packagePath, "Recommends"),
    },
  });
  verifyGlibcBaseline(packagePath, configuration);
}

function verifyRpmPackage(packagePath, architecture, configuration) {
  validateRpmPackage({
    architecture,
    configuration,
    dependencies: run("rpm", ["-qp", "--requires", packagePath]).split(
      /\r?\n/u,
    ),
    fields: {
      name: readRpmField(packagePath, "NAME"),
      version: readRpmField(packagePath, "VERSION"),
      architecture: readRpmField(packagePath, "ARCH"),
      homepage: readRpmField(packagePath, "URL"),
      summary: readRpmField(packagePath, "SUMMARY"),
      description: readRpmField(packagePath, "DESCRIPTION"),
    },
    packagePaths: run("rpm", ["-qpl", packagePath]).split(/\r?\n/u),
    recommendations: run("rpm", ["-qp", "--recommends", packagePath]).split(
      /\r?\n/u,
    ),
  });
}

async function runCli() {
  const [format, packagePath, architecture, configurationPath] =
    process.argv.slice(2);

  if (
    !["deb", "rpm"].includes(format) ||
    !packagePath ||
    !architecture ||
    !configurationPath
  ) {
    throw new Error(
      "Usage: verify-linux-package.mjs <deb|rpm> <package> <architecture> <tauri-configuration>",
    );
  }

  const configuration = JSON.parse(
    readFileSync(configurationPath, { encoding: "utf8" }),
  );

  if (format === "deb") {
    verifyDebianPackage(packagePath, architecture, configuration);
  } else {
    verifyRpmPackage(packagePath, architecture, configuration);
  }
}

const modulePath = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
