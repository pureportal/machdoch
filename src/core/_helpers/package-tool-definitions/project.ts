import { existsSync, type Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  isPathInsideWorkspace,
  normalizeWorkspacePath,
  resolveWorkspaceTarget,
} from "../agent-tools-shared.js";
import {
  DEPENDENCY_SECTIONS,
  IGNORED_WORKSPACE_DISCOVERY_DIRECTORIES,
  MAX_WORKSPACE_PACKAGES,
  MAX_WORKSPACE_PATTERNS,
  MAX_WORKSPACE_PATTERN_LENGTH,
  NODE_PACKAGE_MANAGERS,
  isRecord,
  type DependencySection,
  type NodePackageManager,
  type NodePackageProject,
  type NodeWorkspacePackage,
  type PackageLockfileInfo,
  type PackageManagerDetection,
  type PackageManifest,
} from "./model.js";

const coerceStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : [],
    ),
  );
};

const coerceWorkspacePatterns = (value: unknown): string[] => {
  const rawPatterns = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.packages)
      ? value.packages
      : [];
  const patterns = rawPatterns.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0
      ? [entry.trim()]
      : [],
  );

  return Array.from(new Set(patterns))
    .filter((pattern) => pattern.length <= MAX_WORKSPACE_PATTERN_LENGTH)
    .slice(0, MAX_WORKSPACE_PATTERNS);
};

const parsePackageManifest = (raw: string): PackageManifest => {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("package.json did not contain a JSON object.");
  }

  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
    ...(typeof parsed.private === "boolean"
      ? { private: parsed.private }
      : {}),
    ...(typeof parsed.packageManager === "string"
      ? { packageManager: parsed.packageManager }
      : {}),
    scripts: coerceStringRecord(parsed.scripts),
    dependencies: Object.fromEntries(
      DEPENDENCY_SECTIONS.map((section) => [
        section,
        coerceStringRecord(parsed[section]),
      ]),
    ) as Record<DependencySection, Record<string, string>>,
    workspaces: coerceWorkspacePatterns(parsed.workspaces),
  };
};

const parsePackageLockMetadata = async (
  packageRoot: string,
): Promise<PackageLockfileInfo | undefined> => {
  const lockfilePath = join(packageRoot, "package-lock.json");

  if (!existsSync(lockfilePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(lockfilePath, "utf8")) as unknown;
    const raw = isRecord(parsed) ? parsed : {};
    const packages = isRecord(raw.packages) ? raw.packages : undefined;

    return {
      name: "package-lock.json",
      manager: "npm",
      ...(typeof raw.lockfileVersion === "number"
        ? { lockfileVersion: raw.lockfileVersion }
        : {}),
      ...(packages ? { packageCount: Object.keys(packages).length } : {}),
    };
  } catch {
    return {
      name: "package-lock.json",
      manager: "npm",
    };
  }
};

const detectLockfiles = async (
  packageRoot: string,
): Promise<PackageLockfileInfo[]> => {
  const npmLockfile = await parsePackageLockMetadata(packageRoot);
  const lockfiles: PackageLockfileInfo[] = npmLockfile ? [npmLockfile] : [];

  for (const lockfile of [
    { name: "pnpm-lock.yaml", manager: "pnpm" },
    { name: "yarn.lock", manager: "yarn" },
    { name: "bun.lock", manager: "bun" },
    { name: "bun.lockb", manager: "bun" },
  ] as const) {
    if (existsSync(join(packageRoot, lockfile.name))) {
      lockfiles.push(lockfile);
    }
  }

  return lockfiles;
};

const parsePackageManagerField = (
  packageManager: string | undefined,
): { manager: NodePackageManager; version?: string } | undefined => {
  const normalized = packageManager?.trim();

  if (!normalized) {
    return undefined;
  }

  const match = /^(npm|pnpm|yarn|bun)(?:@(.+))?$/u.exec(normalized);

  if (!match) {
    return undefined;
  }

  const manager = match[1];

  if (!NODE_PACKAGE_MANAGERS.includes(manager as NodePackageManager)) {
    return undefined;
  }

  return {
    manager: manager as NodePackageManager,
    ...(match[2] ? { version: match[2] } : {}),
  };
};

const detectPackageManager = (
  manifest: PackageManifest,
  lockfiles: PackageLockfileInfo[],
): PackageManagerDetection => {
  const explicitManager = parsePackageManagerField(manifest.packageManager);

  if (explicitManager) {
    return {
      manager: explicitManager.manager,
      source: "packageManager",
      ...(explicitManager.version ? { version: explicitManager.version } : {}),
    };
  }

  const lockfileManager = lockfiles[0]?.manager;

  if (lockfileManager) {
    return {
      manager: lockfileManager,
      source: "lockfile",
    };
  }

  return {
    manager: "npm",
    source: "default",
  };
};

const createLockfileWarnings = (
  manifest: PackageManifest,
  lockfiles: PackageLockfileInfo[],
  detection: PackageManagerDetection,
): string[] => {
  const warnings: string[] = [];
  const lockfileManagers = Array.from(
    new Set(lockfiles.map((lockfile) => lockfile.manager)),
  ).sort();
  const explicitManager = parsePackageManagerField(manifest.packageManager);

  if (lockfileManagers.length > 1) {
    warnings.push(
      `Multiple package-manager lockfiles detected (${lockfileManagers.join(", ")}); using ${detection.manager} from ${detection.source}.`,
    );
  }

  if (explicitManager) {
    const mismatchedLockfileManagers = lockfileManagers.filter(
      (manager) => manager !== explicitManager.manager,
    );

    if (mismatchedLockfileManagers.length > 0) {
      warnings.push(
        `The packageManager field selects ${explicitManager.manager}, but lockfiles also indicate ${mismatchedLockfileManagers.join(", ")}.`,
      );
    }
  }

  return warnings;
};

const normalizeWorkspacePattern = (pattern: string): string | undefined => {
  const trimmed = pattern.trim();

  if (
    trimmed.length === 0 ||
    trimmed.includes("\0") ||
    trimmed.startsWith("!") ||
    trimmed.startsWith("../") ||
    trimmed === ".." ||
    trimmed.includes("/../") ||
    isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/u.test(trimmed)
  ) {
    return undefined;
  }

  const normalized = normalizeWorkspacePath(
    trimmed
      .replace(/\\/gu, "/")
      .replace(/\/package\.json$/u, "")
      .replace(/\/$/u, ""),
  );

  return normalized.length > 0 ? normalized : undefined;
};

const splitWorkspacePattern = (pattern: string): string[] => {
  return pattern.split("/").filter((segment) => segment.length > 0);
};

const hasGlobSyntax = (segment: string): boolean => {
  return segment.includes("*") || segment.includes("?");
};

const getWorkspacePatternStaticPrefix = (pattern: string): string => {
  const prefixSegments: string[] = [];

  for (const segment of splitWorkspacePattern(pattern)) {
    if (segment === "**" || hasGlobSyntax(segment)) {
      break;
    }

    prefixSegments.push(segment);
  }

  return prefixSegments.join("/");
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
};

const createWorkspaceSegmentMatcher = (segment: string): RegExp => {
  const source = escapeRegExp(segment)
    .replace(/\\\*/gu, "[^/]*")
    .replace(/\\\?/gu, "[^/]");

  return new RegExp(`^${source}$`, "u");
};

const matchWorkspacePatternSegments = (
  patternSegments: string[],
  pathSegments: string[],
  patternIndex = 0,
  pathIndex = 0,
): boolean => {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }

  const segment = patternSegments[patternIndex];

  if (segment === undefined) {
    return false;
  }

  if (segment === "**") {
    return (
      matchWorkspacePatternSegments(
        patternSegments,
        pathSegments,
        patternIndex + 1,
        pathIndex,
      ) ||
      (pathIndex < pathSegments.length &&
        matchWorkspacePatternSegments(
          patternSegments,
          pathSegments,
          patternIndex,
          pathIndex + 1,
        ))
    );
  }

  const pathSegment = pathSegments[pathIndex];

  if (pathSegment === undefined) {
    return false;
  }

  return (
    createWorkspaceSegmentMatcher(segment).test(pathSegment) &&
    matchWorkspacePatternSegments(
      patternSegments,
      pathSegments,
      patternIndex + 1,
      pathIndex + 1,
    )
  );
};

const matchesWorkspacePattern = (
  pattern: string,
  workspacePath: string,
): boolean => {
  return matchWorkspacePatternSegments(
    splitWorkspacePattern(pattern),
    splitWorkspacePattern(workspacePath),
  );
};

const collectPackageJsonPaths = async (
  directoryPath: string,
  packageJsonPaths: Set<string>,
): Promise<void> => {
  if (packageJsonPaths.size >= MAX_WORKSPACE_PACKAGES) {
    return;
  }

  let entries: Dirent<string>[];

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    packageJsonPaths.add(join(directoryPath, "package.json"));
  }

  for (const entry of entries) {
    if (packageJsonPaths.size >= MAX_WORKSPACE_PACKAGES) {
      return;
    }

    if (
      !entry.isDirectory() ||
      IGNORED_WORKSPACE_DISCOVERY_DIRECTORIES.has(entry.name)
    ) {
      continue;
    }

    await collectPackageJsonPaths(join(directoryPath, entry.name), packageJsonPaths);
  }
};

const resolveWorkspacePatternSearchRoot = async (
  packageRoot: string,
  pattern: string,
): Promise<string | undefined> => {
  const staticPrefix = getWorkspacePatternStaticPrefix(pattern);
  const searchRoot = staticPrefix
    ? join(packageRoot, ...staticPrefix.split("/"))
    : packageRoot;

  if (!existsSync(searchRoot)) {
    return undefined;
  }

  try {
    const resolvedPackageRoot = await realpath(packageRoot);
    const resolvedSearchRoot = await realpath(searchRoot);

    return isPathInsideWorkspace(resolvedPackageRoot, resolvedSearchRoot)
      ? resolvedSearchRoot
      : undefined;
  } catch {
    return undefined;
  }
};

const countManifestDependencies = (manifest: PackageManifest): number => {
  return DEPENDENCY_SECTIONS.reduce(
    (total, section) =>
      total + Object.keys(manifest.dependencies[section]).length,
    0,
  );
};

const discoverWorkspacePackages = async (
  packageRoot: string,
  manifest: PackageManifest,
): Promise<NodeWorkspacePackage[]> => {
  if (manifest.workspaces.length === 0) {
    return [];
  }

  const packageJsonPaths = new Set<string>();
  const resolvedPackageRoot = await realpath(packageRoot);

  for (const rawPattern of manifest.workspaces) {
    const pattern = normalizeWorkspacePattern(rawPattern);

    if (!pattern) {
      continue;
    }

    const searchRoot = await resolveWorkspacePatternSearchRoot(
      resolvedPackageRoot,
      pattern,
    );

    if (!searchRoot) {
      continue;
    }

    const candidates = new Set<string>();
    await collectPackageJsonPaths(searchRoot, candidates);

    for (const candidatePath of candidates) {
      try {
        const resolvedCandidatePath = await realpath(candidatePath);
        const workspacePath = normalizeWorkspacePath(
          relative(resolvedPackageRoot, dirname(resolvedCandidatePath)),
        );

        if (
          workspacePath.length > 0 &&
          matchesWorkspacePattern(pattern, workspacePath)
        ) {
          packageJsonPaths.add(resolvedCandidatePath);
        }
      } catch {
        continue;
      }
    }
  }

  const workspacePackages: NodeWorkspacePackage[] = [];

  for (const packageJsonPath of Array.from(packageJsonPaths).sort()) {
    try {
      const workspaceManifest = parsePackageManifest(
        await readFile(packageJsonPath, "utf8"),
      );

      workspacePackages.push({
        path: normalizeWorkspacePath(
          relative(resolvedPackageRoot, dirname(packageJsonPath)),
        ),
        packageJsonPath,
        ...(workspaceManifest.name ? { name: workspaceManifest.name } : {}),
        ...(workspaceManifest.version
          ? { version: workspaceManifest.version }
          : {}),
        ...(workspaceManifest.private !== undefined
          ? { private: workspaceManifest.private }
          : {}),
        scriptCount: Object.keys(workspaceManifest.scripts).length,
        dependencyCount: countManifestDependencies(workspaceManifest),
      });
    } catch {
      continue;
    }
  }

  return workspacePackages;
};

export const resolvePackageProject = async (
  workspaceRoot: string,
  requestedPath: string | undefined,
): Promise<NodePackageProject> => {
  const packageTarget = await resolveWorkspaceTarget(
    workspaceRoot,
    requestedPath ?? ".",
  );

  if (!packageTarget.insideWorkspace) {
    throw new Error(
      `Refusing package path \`${requestedPath ?? "."}\` because it resolves outside the workspace.`,
    );
  }

  const targetStats = await stat(packageTarget.resolvedPath);
  const packageJsonPath = targetStats.isDirectory()
    ? join(packageTarget.resolvedPath, "package.json")
    : packageTarget.resolvedPath;

  if (basename(packageJsonPath) !== "package.json") {
    throw new Error(
      "Expected `packagePath` to reference a package directory or package.json file.",
    );
  }

  const resolvedWorkspaceRoot = await realpath(workspaceRoot);
  const resolvedPackageJsonPath = await realpath(packageJsonPath);

  if (!isPathInsideWorkspace(resolvedWorkspaceRoot, resolvedPackageJsonPath)) {
    throw new Error(
      "The requested package.json resolves outside the active workspace boundary.",
    );
  }

  const packageRoot = dirname(resolvedPackageJsonPath);
  const rawManifest = await readFile(resolvedPackageJsonPath, "utf8");
  const manifest = parsePackageManifest(rawManifest);
  const lockfiles = await detectLockfiles(packageRoot);
  const detection = detectPackageManager(manifest, lockfiles);

  return {
    packageRoot,
    packageJsonPath: resolvedPackageJsonPath,
    manifest,
    manager: detection.manager,
    managerSource: detection.source,
    ...(detection.version ? { managerVersion: detection.version } : {}),
    lockfiles,
    lockfileWarnings: createLockfileWarnings(manifest, lockfiles, detection),
    workspacePackages: await discoverWorkspacePackages(packageRoot, manifest),
  };
};
