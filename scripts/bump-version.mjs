#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const bumpKinds = new Set(["patch", "minor", "major"]);
const usage = `Usage:\n  npm run version:bump -- <patch|minor|major|x.y.z> [--dry-run]\n\nExamples:\n  npm run version:bump -- patch\n  npm run version:bump -- minor --dry-run\n  npm run version:bump -- 0.3.0\n`;

const targetFiles = [
  {
    path: "package.json",
    update: (content, currentVersion, nextVersion) => {
      const packageJson = JSON.parse(content);

      assertVersion(packageJson.version, currentVersion, "package.json");
      packageJson.version = nextVersion;

      return `${JSON.stringify(packageJson, null, 2)}\n`;
    },
  },
  {
    path: "package-lock.json",
    update: (content, currentVersion, nextVersion) => {
      const packageLock = JSON.parse(content);

      assertVersion(packageLock.version, currentVersion, "package-lock.json");

      const rootPackage = packageLock.packages?.[""];
      if (!rootPackage || typeof rootPackage !== "object") {
        throw new Error('package-lock.json is missing packages[""]');
      }

      assertVersion(rootPackage.version, currentVersion, 'package-lock.json packages[""]');

      packageLock.version = nextVersion;
      rootPackage.version = nextVersion;

      return `${JSON.stringify(packageLock, null, 2)}\n`;
    },
  },
  {
    path: "src-tauri/Cargo.toml",
    update: (content, currentVersion, nextVersion) =>
      replaceSingleVersion(
        content,
        /^(version = ")([^"]+)(")$/m,
        currentVersion,
        nextVersion,
        "src-tauri/Cargo.toml",
      ),
  },
  {
    path: "src-tauri/Cargo.lock",
    update: (content, currentVersion, nextVersion) =>
      replaceSingleVersion(
        content,
        /(\[\[package\]\]\r?\nname = "machdoch"\r?\nversion = ")([^"]+)(")/,
        currentVersion,
        nextVersion,
        "src-tauri/Cargo.lock",
      ),
  },
  {
    path: "src-tauri/tauri.conf.json",
    update: (content, currentVersion, nextVersion) => {
      const tauriConfig = JSON.parse(content);

      assertVersion(tauriConfig.version, currentVersion, "src-tauri/tauri.conf.json");
      tauriConfig.version = nextVersion;

      return `${JSON.stringify(tauriConfig, null, 2)}\n`;
    },
  },
];

const args = process.argv.slice(2);
const bumpArg = args.find((argument) => !argument.startsWith("-"));
const dryRun = args.includes("--dry-run");
const unknownFlags = args.filter(
  (argument) => argument.startsWith("-") && argument !== "--dry-run",
);

if (!bumpArg || unknownFlags.length > 0) {
  if (unknownFlags.length > 0) {
    console.error(`Unknown option(s): ${unknownFlags.join(", ")}`);
    console.error();
  }

  console.error(usage);
  process.exit(1);
}

const packageJsonPath = resolve(projectRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const currentVersion = packageJson.version;

assertValidVersion(currentVersion, "package.json");

const nextVersion = bumpKinds.has(bumpArg)
  ? bumpVersion(currentVersion, bumpArg)
  : normalizeExplicitVersion(bumpArg);

if (nextVersion === currentVersion) {
  console.error(`Version is already ${currentVersion}.`);
  process.exit(1);
}

const fileUpdates = [];
for (const targetFile of targetFiles) {
  const filePath = resolve(projectRoot, targetFile.path);
  let originalContent;
  try {
    originalContent = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  const nextContent = targetFile.update(originalContent, currentVersion, nextVersion);

  if (nextContent === originalContent) {
    throw new Error(`No change was produced for ${targetFile.path}.`);
  }

  fileUpdates.push({
    filePath,
    nextContent,
    path: targetFile.path,
  });
}

if (dryRun) {
  console.log(`Dry run: ${currentVersion} -> ${nextVersion}`);
  console.log("Files that would be updated:");
  for (const fileUpdate of fileUpdates) {
    console.log(`- ${fileUpdate.path}`);
  }
  process.exit(0);
}

for (const fileUpdate of fileUpdates) {
  await writeFile(fileUpdate.filePath, fileUpdate.nextContent, "utf8");
}

console.log(`Updated version: ${currentVersion} -> ${nextVersion}`);
console.log("Updated files:");
for (const fileUpdate of fileUpdates) {
  console.log(`- ${fileUpdate.path}`);
}

function normalizeExplicitVersion(version) {
  assertValidVersion(version, "CLI argument");
  return version;
}

function bumpVersion(version, bumpKind) {
  const parsedVersion = parseVersion(version);

  switch (bumpKind) {
    case "major":
      return `${parsedVersion.major + 1}.0.0`;
    case "minor":
      return `${parsedVersion.major}.${parsedVersion.minor + 1}.0`;
    case "patch":
      return `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch + 1}`;
    default:
      throw new Error(`Unsupported bump kind: ${bumpKind}`);
  }
}

function parseVersion(version) {
  assertValidVersion(version, "version");

  const match = version.match(versionPattern);
  if (!match) {
    throw new Error(`Invalid version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function assertValidVersion(version, label) {
  if (!versionPattern.test(version)) {
    throw new Error(`${label} must be a valid semver version, received ${version}.`);
  }
}

function assertVersion(actualVersion, expectedVersion, label) {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${label} is out of sync: expected ${expectedVersion}, received ${actualVersion}.`,
    );
  }
}

function replaceSingleVersion(content, pattern, currentVersion, nextVersion, label) {
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`Could not find version in ${label}.`);
  }

  const matchedVersion = match[2];
  assertVersion(matchedVersion, currentVersion, label);

  return content.replace(pattern, `$1${nextVersion}$3`);
}
