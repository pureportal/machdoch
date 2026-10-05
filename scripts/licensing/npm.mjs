import { readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readManifest(directory) {
  const manifestPath = join(directory, "package.json");
  let manifest;

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read npm package manifest "${manifestPath}".`, {
      cause,
    });
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid npm package manifest "${manifestPath}".`);
  }

  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[field];
    if (dependencies === undefined) {
      continue;
    }
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      throw new Error(`Invalid ${field} in "${manifestPath}".`);
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9_][a-z0-9._-]*$/i.test(name) ||
        typeof range !== "string"
      ) {
        throw new Error(
          `Invalid npm dependency "${name}" in "${manifestPath}".`,
        );
      }
    }
  }

  return manifest;
}

function productionDependencies(manifest) {
  const dependencies = new Map();

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    dependencies.set(name, { range, required: true });
  }
  for (const [name, range] of Object.entries(
    manifest.optionalDependencies ?? {},
  )) {
    dependencies.set(name, { range, required: false });
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!dependencies.has(name)) {
      dependencies.set(name, { range, required: false });
    }
  }

  return [...dependencies.entries()].sort(([left], [right]) =>
    compareText(left, right),
  );
}

async function resolveDependency(packageDirectory, name) {
  let directory = packageDirectory;

  while (true) {
    if (basename(directory) !== "node_modules") {
      const candidate = join(directory, "node_modules", name);
      try {
        return await realpath(candidate);
      } catch (cause) {
        if (cause.code !== "ENOENT" && cause.code !== "ENOTDIR") {
          throw new Error(
            `Cannot resolve npm dependency "${name}" from "${packageDirectory}".`,
            { cause },
          );
        }
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function repositoryUrl(repository) {
  const declaredUrl =
    typeof repository === "string" ? repository : repository?.url;
  if (typeof declaredUrl !== "string" || !declaredUrl.trim()) {
    return "";
  }

  let value = declaredUrl.trim().replace(/^git\+/, "");
  const shorthand = value.match(
    /^(?:(github|gitlab|bitbucket):)?([^\s/:#]+\/[^\s/:#]+(?:\/[^\s/:#]+)*)(?:#.*)?$/,
  );
  if (shorthand) {
    const hosts = {
      github: "github.com",
      gitlab: "gitlab.com",
      bitbucket: "bitbucket.org",
    };
    value = `https://${hosts[shorthand[1] ?? "github"]}/${shorthand[2]}`;
  }
  const sshRepository = value.match(/^git@([^:]+):(.+)$/);
  if (sshRepository) {
    value = `ssh://git@${sshRepository[1]}/${sshRepository[2]}`;
  }

  try {
    const url = new URL(value);
    return ["https:", "http:", "git:", "ssh:"].includes(url.protocol)
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function packageRecord(directory, manifest) {
  if (
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    typeof manifest.version !== "string" ||
    !manifest.version.trim()
  ) {
    throw new Error(
      `Npm package manifest "${join(directory, "package.json")}" must declare a name and version.`,
    );
  }

  return {
    ecosystem: "npm",
    name: manifest.name,
    version: manifest.version,
    license:
      typeof manifest.license === "string" ? manifest.license.trim() : "",
    repository: repositoryUrl(manifest.repository),
    directory,
  };
}

export async function collectNpmPackages(repositoryRoot, workspacePaths) {
  if (
    !Array.isArray(workspacePaths) ||
    workspacePaths.some((path) => typeof path !== "string" || isAbsolute(path))
  ) {
    throw new TypeError(
      "workspacePaths must be an array of repository-relative directories.",
    );
  }

  const root = await realpath(repositoryRoot);
  const workspaceDirectories = new Set();
  for (const workspacePath of workspacePaths) {
    const directory = resolve(root, workspacePath);
    const relativeDirectory = relative(root, directory);
    if (
      relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `Workspace directory "${workspacePath}" is outside the repository.`,
      );
    }
    workspaceDirectories.add(await realpath(directory));
  }

  const manifests = new Map();
  const pending = [...workspaceDirectories];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (manifests.has(directory)) {
      continue;
    }

    const manifest = await readManifest(directory);
    manifests.set(directory, manifest);
    for (const [name, dependency] of productionDependencies(manifest)) {
      const dependencyDirectory = await resolveDependency(directory, name);
      if (!dependencyDirectory) {
        if (dependency.required) {
          throw new Error(
            `Missing required npm dependency "${name}" (${dependency.range}) from "${join(directory, "package.json")}".`,
          );
        }
        continue;
      }
      if (dependency.range.startsWith("workspace:")) {
        workspaceDirectories.add(dependencyDirectory);
      }
      pending.push(dependencyDirectory);
    }
  }

  const packages = new Map();
  for (const [directory, manifest] of manifests) {
    if (workspaceDirectories.has(directory)) {
      continue;
    }
    const record = packageRecord(directory, manifest);
    const key = `${record.name}@${record.version}`;
    const existing = packages.get(key);
    if (!existing || compareText(record.directory, existing.directory) < 0) {
      packages.set(key, record);
    }
  }

  return [...packages.values()].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.version, right.version),
  );
}
