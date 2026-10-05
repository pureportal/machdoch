import { execFile } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const runCargo = promisify(execFile);

function manifestKey(manifestPath) {
  const absolutePath = resolve(manifestPath);
  return process.platform === "win32"
    ? absolutePath.toLowerCase()
    : absolutePath;
}

export function parseRustMetadata(metadata, manifestPath) {
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new TypeError("A Cargo manifest path is required.");
  }
  if (
    !Array.isArray(metadata?.packages) ||
    !Array.isArray(metadata?.workspace_members) ||
    !Array.isArray(metadata?.resolve?.nodes)
  ) {
    throw new Error(
      "Cargo metadata must include packages, workspace members, and a resolved dependency graph.",
    );
  }

  const requestedManifest = manifestKey(manifestPath);
  const root = metadata.packages.find(
    (pkg) =>
      typeof pkg.manifest_path === "string" &&
      manifestKey(pkg.manifest_path) === requestedManifest,
  );
  if (!root) {
    throw new Error(
      `Cargo metadata contains no package for manifest "${resolve(manifestPath)}".`,
    );
  }

  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const workspaceMembers = new Set(metadata.workspace_members);
  const visited = new Set();
  const pending = [root.id];
  const inventory = [];

  while (pending.length > 0) {
    const id = pending.pop();
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);

    const pkg = packages.get(id);
    const node = nodes.get(id);
    if (!pkg || !node) {
      throw new Error(
        `Cargo metadata is missing a package or resolved node for "${id}".`,
      );
    }
    if (!Array.isArray(node.deps)) {
      throw new Error(
        `Cargo metadata is missing resolved dependency edges for "${id}".`,
      );
    }

    for (const dependency of node.deps) {
      if (!Array.isArray(dependency.dep_kinds)) {
        throw new Error(
          `Cargo metadata is missing dependency kinds for "${dependency.pkg}" from "${id}".`,
        );
      }
      if (
        dependency.dep_kinds.some(
          ({ kind }) => kind === null || kind === "build",
        )
      ) {
        pending.push(dependency.pkg);
      }
    }

    const isLocalMachdochCrate =
      pkg.source === null &&
      (workspaceMembers.has(id) ||
        pkg.name === "machdoch" ||
        pkg.name.startsWith("machdoch-"));
    if (id === root.id || isLocalMachdochCrate) {
      continue;
    }
    if (
      typeof pkg.manifest_path !== "string" ||
      !isAbsolute(pkg.manifest_path)
    ) {
      throw new Error(
        `Cargo metadata has no absolute crate manifest path for "${id}".`,
      );
    }

    inventory.push({
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "",
      repository: pkg.repository ?? "",
      directory: dirname(pkg.manifest_path),
      source: pkg.source ?? "",
    });
  }

  return inventory.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.source.localeCompare(right.source) ||
      left.directory.localeCompare(right.directory),
  );
}

export async function collectRustPackages(manifestPath, target) {
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new TypeError("A Cargo manifest path is required.");
  }
  if (typeof target !== "string" || target.trim() === "") {
    throw new TypeError("A Cargo target triple is required.");
  }

  const absoluteManifestPath = resolve(manifestPath);
  let stdout;
  try {
    ({ stdout } = await runCargo(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--manifest-path",
        absoluteManifestPath,
        "--filter-platform",
        target,
      ],
      {
        cwd: dirname(absoluteManifestPath),
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    ));
  } catch (error) {
    const detail = [error.message, error.stderr?.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `Unable to collect Cargo dependencies for "${absoluteManifestPath}" targeting "${target}":\n${detail}`,
      { cause: error },
    );
  }

  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Cargo metadata returned invalid JSON for "${absoluteManifestPath}" targeting "${target}": ${error.message}`,
      { cause: error },
    );
  }

  return parseRustMetadata(metadata, absoluteManifestPath);
}
