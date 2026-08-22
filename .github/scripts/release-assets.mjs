import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const installerAssetDefinitions = [
  {
    platform: "windows",
    sourceDirectory: "msi",
    sourcePattern: /\.msi$/u,
    sourceLabel: "MSI",
    canonicalName: "machdoch-windows-x64.msi",
  },
  {
    platform: "windows",
    sourceDirectory: "nsis",
    sourcePattern: /-setup\.exe$/u,
    sourceLabel: "NSIS",
    canonicalName: "machdoch-windows-x64-setup.exe",
  },
  {
    platform: "linux",
    sourceDirectory: "deb",
    sourcePattern: /\.deb$/u,
    sourceLabel: "Debian",
    canonicalName: "machdoch-linux-amd64.deb",
  },
  {
    platform: "linux",
    sourceDirectory: "rpm",
    sourcePattern: /\.rpm$/u,
    sourceLabel: "RPM",
    canonicalName: "machdoch-linux-x86_64.rpm",
  },
  {
    platform: "linux",
    sourceDirectory: "appimage",
    sourcePattern: /\.AppImage$/u,
    sourceLabel: "AppImage",
    canonicalName: "machdoch-linux-amd64.AppImage",
  },
];

export const canonicalInstallerNames = installerAssetDefinitions.map(
  ({ canonicalName }) => canonicalName,
);

const installerNamePattern =
  /^machdoch.*(?:\.msi|\.exe|\.deb|\.rpm|\.AppImage)$/u;

export function validateConfiguredBundleTargets(targets) {
  if (
    !Array.isArray(targets) ||
    targets.some((target) => typeof target !== "string")
  ) {
    throw new Error(
      "Tauri bundle targets must be an array of installer type names.",
    );
  }

  const configuredTargets = new Set(targets);
  const mappedTargets = new Set(
    installerAssetDefinitions.map(({ sourceDirectory }) => sourceDirectory),
  );
  const unmappedTargets = targets.filter(
    (target) => !mappedTargets.has(target),
  );
  const unconfiguredTargets = [...mappedTargets].filter(
    (target) => !configuredTargets.has(target),
  );

  if (configuredTargets.size !== targets.length) {
    throw new Error("Tauri bundle targets contain duplicates.");
  }

  if (unmappedTargets.length > 0 || unconfiguredTargets.length > 0) {
    throw new Error(
      `Release asset mappings do not match Tauri bundle targets; unmapped: ${unmappedTargets.join(", ") || "none"}; unconfigured: ${unconfiguredTargets.join(", ") || "none"}`,
    );
  }
}

function getPlatformDefinitions(platform) {
  const definitions = installerAssetDefinitions.filter(
    (definition) => definition.platform === platform,
  );

  if (definitions.length === 0) {
    throw new Error(`Unsupported installer platform: ${platform}`);
  }

  return definitions;
}

async function resolveSourceAsset(bundleDirectory, definition) {
  const sourceDirectory = resolve(bundleDirectory, definition.sourceDirectory);
  let entries;

  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Missing ${definition.sourceLabel} bundle directory: ${sourceDirectory}`,
      {
        cause: error,
      },
    );
  }

  const matches = entries
    .filter(
      (entry) => entry.isFile() && definition.sourcePattern.test(entry.name),
    )
    .map((entry) => resolve(sourceDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));

  if (matches.length !== 1) {
    const found = matches.length === 0 ? "none" : matches.join(", ");
    throw new Error(
      `Expected exactly one ${definition.sourceLabel} bundle in ${sourceDirectory}; found ${matches.length}: ${found}`,
    );
  }

  return matches[0];
}

export async function prepareReleaseAssets({
  platform,
  bundleDirectory,
  outputDirectory,
}) {
  const definitions = getPlatformDefinitions(platform);
  const resolvedAssets = await Promise.all(
    definitions.map(async (definition) => ({
      definition,
      sourcePath: await resolveSourceAsset(bundleDirectory, definition),
    })),
  );
  const resolvedOutputDirectory = resolve(outputDirectory);

  try {
    await mkdir(resolvedOutputDirectory);
  } catch (error) {
    throw new Error(
      `Release asset output directory must not already exist: ${resolvedOutputDirectory}`,
      { cause: error },
    );
  }

  return Promise.all(
    resolvedAssets.map(async ({ definition, sourcePath }) => {
      const destinationPath = resolve(
        resolvedOutputDirectory,
        definition.canonicalName,
      );
      await copyFile(sourcePath, destinationPath);
      return destinationPath;
    }),
  );
}

export function findSupersededInstallerNames(assetNames, version) {
  if (!version) {
    throw new Error(
      "Application version is required to identify superseded release assets.",
    );
  }

  const canonicalNames = new Set(canonicalInstallerNames);

  return assetNames
    .filter(
      (name) =>
        installerNamePattern.test(name) &&
        !canonicalNames.has(name) &&
        name.includes(version),
    )
    .sort((left, right) => left.localeCompare(right));
}

export function validatePublishedInstallerNames(assetNames, version) {
  if (!version) {
    throw new Error(
      "Application version is required to validate release assets.",
    );
  }

  const installerNames = assetNames.filter((name) =>
    installerNamePattern.test(name),
  );
  const nameCounts = new Map();

  for (const name of installerNames) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const missingNames = canonicalInstallerNames.filter(
    (name) => !nameCounts.has(name),
  );
  const duplicateNames = canonicalInstallerNames.filter(
    (name) => nameCounts.get(name) > 1,
  );
  const unexpectedNames = installerNames
    .filter((name) => !canonicalInstallerNames.includes(name))
    .sort((left, right) => left.localeCompare(right));
  const versionedNames = installerNames.filter((name) =>
    name.includes(version),
  );
  const failures = [];

  if (missingNames.length > 0) {
    failures.push(`missing: ${missingNames.join(", ")}`);
  }

  if (duplicateNames.length > 0) {
    failures.push(`duplicated: ${duplicateNames.join(", ")}`);
  }

  if (unexpectedNames.length > 0) {
    failures.push(`unexpected: ${unexpectedNames.join(", ")}`);
  }

  if (versionedNames.length > 0) {
    failures.push(`contain version ${version}: ${versionedNames.join(", ")}`);
  }

  if (installerNames.length !== canonicalInstallerNames.length) {
    failures.push(
      `expected ${canonicalInstallerNames.length} installer assets, found ${installerNames.length}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Invalid published installer assets: ${failures.join("; ")}`,
    );
  }
}

async function readReleaseAssetNames(releaseJsonPath) {
  const release = JSON.parse(await readFile(releaseJsonPath, "utf8"));

  if (!Array.isArray(release.assets)) {
    throw new Error(
      `Release JSON does not contain an assets array: ${releaseJsonPath}`,
    );
  }

  const invalidAsset = release.assets.find(
    (asset) => typeof asset?.name !== "string",
  );

  if (invalidAsset) {
    throw new Error(
      `Release JSON contains an asset without a name: ${releaseJsonPath}`,
    );
  }

  return release.assets.map(({ name }) => name);
}

async function writeGitHubPaths(outputPath, paths) {
  const delimiter = `release_assets_${process.pid}`;
  const workflowPaths = paths.map((path) =>
    relative(process.cwd(), path).split(sep).join("/"),
  );
  await appendFile(
    outputPath,
    `paths<<${delimiter}\n${workflowPaths.join("\n")}\n${delimiter}\n`,
  );
}

async function validateTauriConfiguration(configurationPath) {
  const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
  validateConfiguredBundleTargets(configuration?.bundle?.targets);
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "prepare") {
    if (args.length !== 5) {
      throw new Error(
        "Usage: release-assets.mjs prepare <platform> <bundle-directory> <output-directory> <tauri-configuration> <github-output>",
      );
    }

    const [
      platform,
      bundleDirectory,
      outputDirectory,
      tauriConfiguration,
      githubOutput,
    ] = args;
    await validateTauriConfiguration(tauriConfiguration);
    const paths = await prepareReleaseAssets({
      platform,
      bundleDirectory,
      outputDirectory,
    });
    await writeGitHubPaths(githubOutput, paths);
    return;
  }

  if (command === "superseded") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: release-assets.mjs superseded <version> <release-json>",
      );
    }

    const [version, releaseJsonPath] = args;
    const names = findSupersededInstallerNames(
      await readReleaseAssetNames(releaseJsonPath),
      version,
    );
    process.stdout.write(names.map((name) => `${name}\n`).join(""));
    return;
  }

  if (command === "verify") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: release-assets.mjs verify <version> <release-json>",
      );
    }

    const [version, releaseJsonPath] = args;
    validatePublishedInstallerNames(
      await readReleaseAssetNames(releaseJsonPath),
      version,
    );
    return;
  }

  throw new Error(`Unknown release asset command: ${command ?? ""}`);
}

const modulePath = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
