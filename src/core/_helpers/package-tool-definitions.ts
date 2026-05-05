import { existsSync, type Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  coerceBoolean,
  coerceInteger,
  coerceString,
  createToolErrorResult,
  isPathInsideWorkspace,
  normalizeWorkspacePath,
  resolveWorkspaceTarget,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
  stringifyUnknown,
} from "./runtime-text.js";
import {
  executeLocalCommand,
  formatLocalCommandError,
  type LocalCommandResult,
} from "./process-execution.js";

const PACKAGE_TIMEOUT_MS = 120_000;
const PACKAGE_AUDIT_TIMEOUT_MS = 120_000;
const PACKAGE_MAX_BUFFER_BYTES = 1_500_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
const MAX_SCRIPT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTDATED_RESULTS = 25;
const MAX_OUTDATED_RESULTS = 100;
const DEFAULT_AUDIT_RESULTS = 25;
const MAX_AUDIT_RESULTS = 100;
const MAX_PACKAGE_SPECS = 20;
const MAX_PACKAGE_SPEC_LENGTH = 220;
const MAX_SCRIPT_ARGS = 40;
const MAX_SCRIPT_ARG_LENGTH = 1_000;
const MAX_WORKSPACE_PATTERNS = 50;
const MAX_WORKSPACE_PATTERN_LENGTH = 220;
const MAX_WORKSPACE_PACKAGES = 120;

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const NODE_PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
const AUDIT_SEVERITIES = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
] as const;
const CONFIGURABLE_AUDIT_LEVELS = [
  "low",
  "moderate",
  "high",
  "critical",
] as const;
const AUDIT_SEVERITY_RANK: Record<AuditSeverity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
const IGNORED_WORKSPACE_DISCOVERY_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".yarn",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "target",
]);

type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];
type NodePackageManager = (typeof NODE_PACKAGE_MANAGERS)[number];
type ManagerDetectionSource = "packageManager" | "lockfile" | "default";
type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];
type ConfigurableAuditLevel = (typeof CONFIGURABLE_AUDIT_LEVELS)[number];

interface NodePackageProject {
  packageRoot: string;
  packageJsonPath: string;
  manifest: PackageManifest;
  manager: NodePackageManager;
  managerSource: ManagerDetectionSource;
  managerVersion?: string;
  lockfiles: PackageLockfileInfo[];
  lockfileWarnings: string[];
  workspacePackages: NodeWorkspacePackage[];
}

interface PackageManagerDetection {
  manager: NodePackageManager;
  source: ManagerDetectionSource;
  version?: string;
}

interface PackageLockfileInfo {
  name: string;
  manager: NodePackageManager;
  lockfileVersion?: number;
  packageCount?: number;
}

interface NodeWorkspacePackage {
  path: string;
  packageJsonPath: string;
  name?: string;
  version?: string;
  private?: boolean;
  scriptCount: number;
  dependencyCount: number;
}

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  packageManager?: string;
  scripts: Record<string, string>;
  dependencies: Record<DependencySection, Record<string, string>>;
  workspaces: string[];
}

interface NodeOutdatedEntry {
  name: string;
  current?: string;
  wanted?: string;
  latest?: string;
  dependent?: string;
  location?: string;
  type?: string;
}

interface PackageAuditEntry {
  name: string;
  severity?: AuditSeverity;
  title?: string;
  range?: string;
  via?: string;
  fixAvailable?: string;
  url?: string;
}

interface PackageAuditSummary {
  counts: Record<AuditSeverity, number>;
  total: number;
  entries: PackageAuditEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

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

const resolvePackageProject = async (
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

const dependencyCountLines = (manifest: PackageManifest): string[] => {
  return DEPENDENCY_SECTIONS.map((section) => {
    const count = Object.keys(manifest.dependencies[section]).length;
    return `${section}: ${count}`;
  });
};

const formatManagerSource = (project: NodePackageProject): string => {
  switch (project.managerSource) {
    case "packageManager": {
      return project.managerVersion
        ? `packageManager (${project.managerVersion})`
        : "packageManager";
    }
    case "lockfile": {
      return "lockfile";
    }
    case "default": {
      return "default";
    }
  }
};

const formatLockfile = (lockfile: PackageLockfileInfo): string => {
  return [
    `${lockfile.name} (${lockfile.manager})`,
    lockfile.lockfileVersion !== undefined
      ? `lockfileVersion=${lockfile.lockfileVersion}`
      : undefined,
    lockfile.packageCount !== undefined
      ? `packages=${lockfile.packageCount}`
      : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

const formatWorkspacePackage = (
  workspacePackage: NodeWorkspacePackage,
): string => {
  return [
    `${workspacePackage.path}: ${workspacePackage.name ?? "(unnamed)"}`,
    workspacePackage.version ? `version=${workspacePackage.version}` : undefined,
    workspacePackage.private !== undefined
      ? `private=${workspacePackage.private ? "yes" : "no"}`
      : undefined,
    `scripts=${workspacePackage.scriptCount}`,
    `deps=${workspacePackage.dependencyCount}`,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

const normalizeStringArray = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0
      ? [entry.trim()]
      : [],
  );

  if (normalized.length > maxItems) {
    return undefined;
  }

  return normalized.every(
    (entry) => entry.length <= maxLength && !entry.includes("\0"),
  )
    ? normalized
    : undefined;
};

const normalizeScriptArgs = (value: unknown): string[] | undefined => {
  return value === undefined
    ? []
    : normalizeStringArray(value, MAX_SCRIPT_ARGS, MAX_SCRIPT_ARG_LENGTH);
};

const normalizePackageSpecs = (value: unknown): string[] | undefined => {
  const packageSpecs = normalizeStringArray(
    value,
    MAX_PACKAGE_SPECS,
    MAX_PACKAGE_SPEC_LENGTH,
  );

  if (!packageSpecs) {
    return undefined;
  }

  const invalidSpec = packageSpecs.find(
    (spec) =>
      /\s/u.test(spec) ||
      spec.startsWith("-") ||
      spec.startsWith(".") ||
      spec.startsWith("/") ||
      spec.startsWith("~") ||
      /^[A-Za-z]:[\\/]/u.test(spec) ||
      /^(?:file|link|portal|workspace|patch|git(?:\+ssh|\+https|\+http|\+file)?|https?|ssh):/iu.test(
        spec,
      ) ||
      /@(?:file|link|portal|workspace|patch|git(?:\+ssh|\+https|\+http|\+file)?|https?|ssh|github|gitlab|bitbucket):/iu.test(
        spec,
      ) ||
      spec.includes("://") ||
      spec.startsWith("github:") ||
      spec.startsWith("gitlab:") ||
      spec.startsWith("bitbucket:"),
  );

  return invalidSpec ? undefined : packageSpecs;
};

const scriptCommandArgs = (
  manager: NodePackageManager,
  script: string,
  scriptArgs: string[],
): string[] => {
  switch (manager) {
    case "npm": {
      return [
        "run",
        script,
        ...(scriptArgs.length > 0 ? ["--", ...scriptArgs] : []),
      ];
    }
    case "pnpm":
    case "yarn":
    case "bun": {
      return ["run", script, ...scriptArgs];
    }
  }
};

const installCommandArgs = (
  manager: NodePackageManager,
  packageSpecs: string[],
  options: { dev: boolean; exact: boolean; lockfileOnly: boolean },
): string[] => {
  switch (manager) {
    case "npm": {
      return [
        "install",
        ...(options.dev ? ["--save-dev"] : []),
        ...(options.exact ? ["--save-exact"] : []),
        ...(options.lockfileOnly ? ["--package-lock-only"] : []),
        ...packageSpecs,
      ];
    }
    case "pnpm": {
      return [
        "add",
        ...(options.dev ? ["--save-dev"] : []),
        ...(options.exact ? ["--save-exact"] : []),
        ...packageSpecs,
      ];
    }
    case "yarn": {
      return [
        "add",
        ...(options.dev ? ["--dev"] : []),
        ...(options.exact ? ["--exact"] : []),
        ...packageSpecs,
      ];
    }
    case "bun": {
      return [
        "add",
        ...(options.dev ? ["--dev"] : []),
        ...(options.exact ? ["--exact"] : []),
        ...(options.lockfileOnly ? ["--lockfile-only"] : []),
        ...packageSpecs,
      ];
    }
  }
};

const runPackageManager = async (
  project: NodePackageProject,
  args: string[],
  timeoutMs = PACKAGE_TIMEOUT_MS,
  acceptedExitCodes?: number[],
): Promise<LocalCommandResult> => {
  return executeLocalCommand(project.manager, args, {
    cwd: project.packageRoot,
    timeoutMs,
    maxBufferBytes: PACKAGE_MAX_BUFFER_BYTES,
    ...(acceptedExitCodes ? { acceptedExitCodes } : {}),
  });
};

const coerceBoundedInteger = (
  args: Record<string, unknown>,
  field: string,
  defaultValue: number,
  maxValue: number,
): number | undefined => {
  const value = coerceInteger(args, field) ?? defaultValue;

  return value >= 1 && value <= maxValue ? value : undefined;
};

const coerceScriptTimeout = (args: Record<string, unknown>): number => {
  const timeoutMs =
    coerceInteger(args, "timeoutMs") ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  return Math.min(Math.max(timeoutMs, 1_000), MAX_SCRIPT_TIMEOUT_MS);
};

const coerceAuditLevel = (
  args: Record<string, unknown>,
): ConfigurableAuditLevel | undefined => {
  const value = coerceString(args, "auditLevel") ?? "low";

  return CONFIGURABLE_AUDIT_LEVELS.includes(value as ConfigurableAuditLevel)
    ? (value as ConfigurableAuditLevel)
    : undefined;
};

const firstStringField = (
  record: Record<string, unknown>,
  fields: string[],
): string | undefined => {
  for (const field of fields) {
    const value = record[field];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const normalizeAuditSeverity = (value: unknown): AuditSeverity | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase();

  return AUDIT_SEVERITIES.includes(normalized as AuditSeverity)
    ? (normalized as AuditSeverity)
    : undefined;
};

const createEmptyAuditCounts = (): Record<AuditSeverity, number> => {
  return {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
};

const parseJsonOrJsonLines = (output: string): unknown[] => {
  const trimmed = output.trim();

  if (!trimmed) {
    return [];
  }

  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    return trimmed
      .split("\n")
      .flatMap((line) => {
        const trimmedLine = line.trim();

        if (!trimmedLine) {
          return [];
        }

        try {
          return [JSON.parse(trimmedLine) as unknown];
        } catch {
          return [];
        }
      });
  }
};

const parseNodeOutdated = (stdout: string): NodeOutdatedEntry[] => {
  const parsed = parseJsonOrJsonLines(stdout)[0];

  if (Array.isArray(parsed)) {
    return parsed.flatMap((value) =>
      isRecord(value) ? [createOutdatedEntry(value)] : [],
    );
  }

  if (!isRecord(parsed)) {
    return [];
  }

  return Object.entries(parsed).flatMap(([name, value]) => {
    if (!isRecord(value)) {
      return [];
    }

    return [createOutdatedEntry(value, name)];
  });
};

const createOutdatedEntry = (
  record: Record<string, unknown>,
  fallbackName?: string,
): NodeOutdatedEntry => {
  const name =
    firstStringField(record, ["name", "packageName", "package"]) ??
    fallbackName ??
    "(unknown)";
  const current = firstStringField(record, ["current", "installed"]);
  const wanted = firstStringField(record, [
    "wanted",
    "update",
    "latestMatching",
  ]);
  const latest = firstStringField(record, ["latest"]);
  const dependent = firstStringField(record, [
    "dependent",
    "dependedBy",
    "workspace",
  ]);
  const location = firstStringField(record, ["location", "path"]);
  const type = firstStringField(record, ["type", "dependencyType"]);

  return {
    name,
    ...(current ? { current } : {}),
    ...(wanted ? { wanted } : {}),
    ...(latest ? { latest } : {}),
    ...(dependent ? { dependent } : {}),
    ...(location ? { location } : {}),
    ...(type ? { type } : {}),
  };
};

const formatOutdatedEntry = (entry: NodeOutdatedEntry): string => {
  return [
    entry.name,
    `current=${entry.current ?? "unknown"}`,
    `wanted=${entry.wanted ?? "unknown"}`,
    `latest=${entry.latest ?? "unknown"}`,
    entry.type ? `type=${entry.type}` : undefined,
    entry.dependent ? `dependent=${entry.dependent}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

const outdatedCommandArgs = (
  manager: NodePackageManager,
  includeAll: boolean,
): string[] | undefined => {
  switch (manager) {
    case "npm": {
      return ["outdated", "--json", ...(includeAll ? ["--all"] : [])];
    }
    case "pnpm": {
      return ["outdated", "--format", "json"];
    }
    case "yarn":
    case "bun": {
      return undefined;
    }
  }
};

const isYarnClassicProject = (project: NodePackageProject): boolean => {
  if (project.manager !== "yarn") {
    return false;
  }

  if (project.managerVersion) {
    return project.managerVersion.startsWith("1.");
  }

  return (
    existsSync(join(project.packageRoot, ".yarnrc")) &&
    !existsSync(join(project.packageRoot, ".yarnrc.yml"))
  );
};

const auditCommandArgs = (
  project: NodePackageProject,
  options: { auditLevel: ConfigurableAuditLevel; productionOnly: boolean },
): string[] => {
  switch (project.manager) {
    case "npm": {
      return [
        "audit",
        "--json",
        `--audit-level=${options.auditLevel}`,
        ...(options.productionOnly ? ["--production"] : []),
      ];
    }
    case "pnpm": {
      return [
        "audit",
        "--json",
        `--audit-level=${options.auditLevel}`,
        ...(options.productionOnly ? ["--prod"] : []),
      ];
    }
    case "bun": {
      return [
        "audit",
        "--json",
        `--audit-level=${options.auditLevel}`,
        ...(options.productionOnly ? ["--prod"] : []),
      ];
    }
    case "yarn": {
      return isYarnClassicProject(project)
        ? [
            "audit",
            "--json",
            "--level",
            options.auditLevel,
            ...(options.productionOnly ? ["--groups", "dependencies"] : []),
          ]
        : [
            "npm",
            "audit",
            "--json",
            "--severity",
            options.auditLevel,
            ...(options.productionOnly ? ["--environment", "production"] : []),
          ];
    }
  }
};

const auditAcceptedExitCodes = (project: NodePackageProject): number[] => {
  return project.manager === "yarn"
    ? Array.from({ length: 32 }, (_value, index) => index)
    : [0, 1];
};

const formatFixAvailable = (value: unknown): string | undefined => {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (isRecord(value)) {
    const name = firstStringField(value, ["name"]);
    const version = firstStringField(value, ["version"]);
    const isSemverMajor = value.isSemVerMajor === true;

    return [
      name,
      version ? `version=${version}` : undefined,
      isSemverMajor ? "semver-major" : undefined,
    ]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
  }

  return undefined;
};

const formatVia = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const via = value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return [entry.trim()];
    }

    if (isRecord(entry)) {
      return firstStringField(entry, ["title", "name", "source"]) ?? [];
    }

    return [];
  });

  return via.length > 0 ? via.slice(0, 3).join(", ") : undefined;
};

const createAuditEntry = (
  record: Record<string, unknown>,
  fallbackName?: string,
): PackageAuditEntry | undefined => {
  const name =
    firstStringField(record, [
      "name",
      "module_name",
      "moduleName",
      "package",
      "packageName",
      "dependency",
    ]) ?? fallbackName;

  if (!name) {
    return undefined;
  }
  const severity = normalizeAuditSeverity(record.severity);
  const title = firstStringField(record, ["title", "overview"]);
  const range = firstStringField(record, ["range", "vulnerable_versions"]);
  const via = formatVia(record.via);
  const fixAvailable = formatFixAvailable(record.fixAvailable);
  const url = firstStringField(record, ["url", "github_advisory_url"]);

  return {
    name,
    ...(severity ? { severity } : {}),
    ...(title ? { title } : {}),
    ...(range ? { range } : {}),
    ...(via ? { via } : {}),
    ...(fixAvailable ? { fixAvailable } : {}),
    ...(url ? { url } : {}),
  };
};

const collectAuditEntries = (value: unknown): PackageAuditEntry[] => {
  if (!isRecord(value)) {
    return [];
  }

  const entries: PackageAuditEntry[] = [];
  const data = isRecord(value.data) ? value.data : undefined;
  const yarnAdvisory = data && isRecord(data.advisory)
    ? data.advisory
    : undefined;

  if (value.type === "auditAdvisory" && yarnAdvisory) {
    const entry = createAuditEntry(yarnAdvisory);

    if (entry) {
      entries.push(entry);
    }
  }

  const vulnerabilities = value.vulnerabilities;

  if (isRecord(vulnerabilities)) {
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
      if (isRecord(vulnerability)) {
        const entry = createAuditEntry(vulnerability, name);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  } else if (Array.isArray(vulnerabilities)) {
    for (const vulnerability of vulnerabilities) {
      if (isRecord(vulnerability)) {
        const entry = createAuditEntry(vulnerability);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  }

  const advisories = value.advisories;

  if (isRecord(advisories)) {
    for (const [name, advisory] of Object.entries(advisories)) {
      if (isRecord(advisory)) {
        const entry = createAuditEntry(advisory, name);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  } else if (Array.isArray(advisories)) {
    for (const advisory of advisories) {
      if (isRecord(advisory)) {
        const entry = createAuditEntry(advisory);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  }

  if (data) {
    entries.push(...collectAuditEntries(data));
  }

  return entries;
};

const mergeAuditCountRecord = (
  value: unknown,
  counts: Record<AuditSeverity, number>,
): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  let sawSeverityCount = false;
  let recordTotal = 0;

  for (const severity of AUDIT_SEVERITIES) {
    const count = value[severity];

    if (typeof count === "number" && Number.isFinite(count)) {
      counts[severity] += count;
      recordTotal += count;
      sawSeverityCount = true;
    }
  }

  if (typeof value.total === "number" && Number.isFinite(value.total)) {
    return value.total;
  }

  return sawSeverityCount
    ? recordTotal
    : undefined;
};

const mergeAuditCounts = (
  value: unknown,
  counts: Record<AuditSeverity, number>,
): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadataCounts =
    isRecord(value.metadata) && isRecord(value.metadata.vulnerabilities)
      ? mergeAuditCountRecord(value.metadata.vulnerabilities, counts)
      : undefined;

  if (metadataCounts !== undefined) {
    return metadataCounts;
  }

  const data = isRecord(value.data) ? value.data : undefined;
  const dataCounts =
    data && isRecord(data.vulnerabilities)
      ? mergeAuditCountRecord(data.vulnerabilities, counts)
      : undefined;

  if (dataCounts !== undefined) {
    return dataCounts;
  }

  return data &&
    isRecord(data.auditSummary) &&
    isRecord(data.auditSummary.vulnerabilities)
    ? mergeAuditCountRecord(data.auditSummary.vulnerabilities, counts)
    : undefined;
};

const uniqueAuditEntries = (
  entries: PackageAuditEntry[],
): PackageAuditEntry[] => {
  const seen = new Set<string>();

  return entries.filter((entry) => {
    const key = [
      entry.name,
      entry.severity ?? "",
      entry.title ?? "",
      entry.range ?? "",
      entry.url ?? "",
    ].join("\0");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const parsePackageAudit = (stdout: string): PackageAuditSummary => {
  const counts = createEmptyAuditCounts();
  const parsedValues = parseJsonOrJsonLines(stdout);
  const metadataTotals: number[] = [];
  const entries = uniqueAuditEntries(
    parsedValues.flatMap((value) => collectAuditEntries(value)),
  ).sort((left, right) => {
    const severityDelta =
      AUDIT_SEVERITY_RANK[right.severity ?? "info"] -
      AUDIT_SEVERITY_RANK[left.severity ?? "info"];

    return severityDelta === 0
      ? left.name.localeCompare(right.name)
      : severityDelta;
  });

  for (const value of parsedValues) {
    const metadataTotal = mergeAuditCounts(value, counts);

    if (metadataTotal !== undefined) {
      metadataTotals.push(metadataTotal);
    }
  }

  if (metadataTotals.length === 0) {
    for (const entry of entries) {
      if (entry.severity) {
        counts[entry.severity] += 1;
      }
    }
  }

  const countedTotal = AUDIT_SEVERITIES.reduce(
    (total, severity) => total + counts[severity],
    0,
  );
  const total =
    metadataTotals.length > 0
      ? metadataTotals.reduce((sum, count) => sum + count, 0)
      : countedTotal > 0
        ? countedTotal
        : entries.length;

  return {
    counts,
    total,
    entries,
  };
};

const formatAuditCounts = (
  counts: Record<AuditSeverity, number>,
): string => {
  return AUDIT_SEVERITIES.map((severity) => `${severity}=${counts[severity]}`)
    .join(", ");
};

const formatAuditEntry = (entry: PackageAuditEntry): string => {
  return [
    entry.severity ? `${entry.name} (${entry.severity})` : entry.name,
    entry.title,
    entry.range ? `range=${entry.range}` : undefined,
    entry.via ? `via=${entry.via}` : undefined,
    entry.fixAvailable ? `fix=${entry.fixAvailable}` : undefined,
    entry.url,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

export const createPackageToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
      spec: {
        name: "inspect_node_package",
        description:
          "Inspect a Node package manifest, scripts, dependency counts, lockfiles, detected package manager, and declared workspaces without mutating files.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
          },
        },
      },
      backingTool: "packages",
      riskLevel: "low",
      execute: async (args, context) => {
        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const scriptNames = Object.keys(project.manifest.scripts).sort();
          const lockfileLines = project.lockfiles.map(formatLockfile);
          const workspaceLines =
            project.workspacePackages.map(formatWorkspacePackage);
          const output = [
            `Package: ${project.manifest.name ?? "(unnamed)"}`,
            `Version: ${project.manifest.version ?? "(none)"}`,
            `Private: ${project.manifest.private === true ? "yes" : "no"}`,
            `Manager: ${project.manager}`,
            `Manager source: ${formatManagerSource(project)}`,
            `Package manager field: ${project.manifest.packageManager ?? "(none)"}`,
            `Package root: ${project.packageRoot}`,
            `Scripts: ${scriptNames.length > 0 ? scriptNames.join(", ") : "(none)"}`,
            ...dependencyCountLines(project.manifest),
            lockfileLines.length > 0
              ? `Lockfiles: ${lockfileLines.join("; ")}`
              : "Lockfiles: none detected",
            `Workspace patterns: ${project.manifest.workspaces.length > 0 ? project.manifest.workspaces.join(", ") : "(none)"}`,
            `Workspace packages: ${project.workspacePackages.length}`,
            workspaceLines.length > 0
              ? ["Workspace package list:", ...workspaceLines].join("\n")
              : undefined,
            project.lockfileWarnings.length > 0
              ? `Warnings: ${project.lockfileWarnings.join(" ")}`
              : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "inspect_node_package",
              output: limitText(output),
            },
            sections: [
              {
                title: "Node package",
                lines: [
                  `name: ${project.manifest.name ?? "(unnamed)"}`,
                  `version: ${project.manifest.version ?? "(none)"}`,
                  `private: ${project.manifest.private === true ? "yes" : "no"}`,
                  `manager: ${project.manager}`,
                  `manager source: ${formatManagerSource(project)}`,
                  `package manager field: ${project.manifest.packageManager ?? "(none)"}`,
                  `package root: ${project.packageRoot}`,
                ],
              },
              {
                title: "Package scripts",
                lines:
                  scriptNames.length > 0
                    ? scriptNames.map(
                        (name) => `${name}: ${project.manifest.scripts[name]}`,
                      )
                    : ["No scripts are declared."],
              },
              {
                title: "Dependency counts",
                lines: dependencyCountLines(project.manifest),
              },
              {
                title: "Package lockfiles",
                lines:
                  lockfileLines.length > 0
                    ? lockfileLines
                    : ["No lockfiles detected."],
              },
              {
                title: "Workspace packages",
                lines:
                  workspaceLines.length > 0
                    ? workspaceLines
                    : project.manifest.workspaces.length > 0
                      ? ["No workspace package.json files matched."]
                      : ["No workspaces declared."],
              },
              ...(project.lockfileWarnings.length > 0
                ? [
                    {
                      title: "Package manager warnings",
                      lines: project.lockfileWarnings,
                    },
                  ]
                : []),
            ],
            traceLines: [
              `inspect_node_package(${project.manifest.name ?? "unnamed"}) -> ${project.manager}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "inspect_node_package",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "run_node_package_script",
        description:
          "Run a declared package.json script through the detected package manager. Use this instead of a raw shell command when executing project scripts because it validates that the script exists first.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            script: {
              type: "string",
              description: "Script name from package.json, such as test.",
            },
            args: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional literal arguments to pass to the script after the package manager separator.",
            },
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_SCRIPT_TIMEOUT_MS,
              description: "Maximum script runtime before termination.",
            },
          },
          required: ["script"],
        },
      },
      backingTool: "packages",
      riskLevel: "high",
      execute: async (args, context) => {
        const script = coerceString(args, "script");
        const scriptArgs = normalizeScriptArgs(args.args);

        if (!script || scriptArgs === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "run_node_package_script",
            "Expected a declared `script` and an optional string-array `args`.",
          );
        }

        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const scriptCommand = project.manifest.scripts[script];

          if (!scriptCommand) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "run_node_package_script",
              `The package.json file does not declare a \`${script}\` script.`,
            );
          }

          const managerArgs = scriptCommandArgs(
            project.manager,
            script,
            scriptArgs,
          );
          const result = await runPackageManager(
            project,
            managerArgs,
            coerceScriptTimeout(args),
          );
          const output = [
            `Command: ${project.manager} ${managerArgs.join(" ")}`,
            `Exit code: ${result.exitCode}`,
            result.stdout ? `STDOUT:\n${result.stdout}` : undefined,
            result.stderr ? `STDERR:\n${result.stderr}` : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "run_node_package_script",
              output: limitText(output),
            },
            sections: [
              {
                title: "Package script",
                lines: [
                  `manager: ${project.manager}`,
                  `script: ${script}`,
                  `package root: ${project.packageRoot}`,
                  `command: ${scriptCommand}`,
                  ...(scriptArgs.length > 0
                    ? [`args: ${scriptArgs.join(" ")}`]
                    : []),
                ],
              },
              createTextSection(
                "Script output",
                [result.stdout, result.stderr].filter(Boolean).join("\n\n") ||
                  "(no output)",
              ),
            ],
            traceLines: [
              `run_node_package_script(${script}) -> exit ${result.exitCode}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "run_node_package_script",
            formatLocalCommandError("package script failed", error),
          );
        }
      },
    },
    {
      spec: {
        name: "check_node_package_outdated",
        description:
          "Check registry metadata for outdated direct dependencies and return a concise JSON-derived summary. Supports npm and pnpm projects.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
            includeAll: {
              type: "boolean",
              description:
                "For npm only, include transitive dependencies using npm outdated --all.",
            },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: MAX_OUTDATED_RESULTS,
              description: "Maximum outdated entries to return.",
            },
          },
        },
      },
      backingTool: "packages",
      riskLevel: "medium",
      execute: async (args, context) => {
        const maxResults = coerceBoundedInteger(
          args,
          "maxResults",
          DEFAULT_OUTDATED_RESULTS,
          MAX_OUTDATED_RESULTS,
        );
        const includeAll = coerceBoolean(args, "includeAll") ?? false;

        if (maxResults === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "check_node_package_outdated",
            `Expected \`maxResults\` to be between 1 and ${MAX_OUTDATED_RESULTS}.`,
          );
        }

        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const managerArgs = outdatedCommandArgs(project.manager, includeAll);

          if (!managerArgs) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "check_node_package_outdated",
              "Outdated checks currently support npm and pnpm projects only.",
            );
          }

          if (includeAll && project.manager !== "npm") {
            return createToolErrorResult(
              crypto.randomUUID(),
              "check_node_package_outdated",
              "`includeAll` is currently supported for npm projects only.",
            );
          }

          const result = await runPackageManager(
            project,
            managerArgs,
            PACKAGE_TIMEOUT_MS,
            [0, 1],
          );
          const entries = parseNodeOutdated(result.stdout);
          const displayedEntries = entries.slice(0, maxResults);
          const entryLines = displayedEntries.map(formatOutdatedEntry);
          const output = [
            `Package: ${project.manifest.name ?? "(unnamed)"}`,
            `Manager: ${project.manager}`,
            `Outdated dependencies: ${entries.length}`,
            entryLines.length > 0
              ? entryLines.join("\n")
              : "No outdated dependencies reported by the package manager.",
            entries.length > maxResults
              ? `... truncated after ${maxResults} of ${entries.length} entries`
              : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "check_node_package_outdated",
              output: limitText(output),
            },
            sections: [
              {
                title: "Package outdated check",
                lines: [
                  `manager: ${project.manager}`,
                  `package root: ${project.packageRoot}`,
                  `outdated dependencies: ${entries.length}`,
                  `exit code: ${result.exitCode}`,
                ],
              },
              {
                title: "Outdated dependencies",
                lines:
                  entryLines.length > 0
                    ? [
                        ...entryLines,
                        ...(entries.length > maxResults
                          ? [
                              `... truncated after ${maxResults} of ${entries.length} entries`,
                            ]
                          : []),
                      ]
                    : ["No outdated dependencies reported."],
              },
            ],
            traceLines: [
              `check_node_package_outdated(${project.manifest.name ?? "unnamed"}) -> ${entries.length} outdated`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "check_node_package_outdated",
            error instanceof SyntaxError
              ? `Package manager returned outdated data that could not be parsed as JSON: ${stringifyUnknown(error.message)}`
              : formatLocalCommandError("package outdated check failed", error),
          );
        }
      },
    },
    {
      spec: {
        name: "audit_node_package_dependencies",
        description:
          "Run a read-only package manager security audit and summarize vulnerabilities from JSON or JSON-lines output. Supports npm, pnpm, yarn, and bun projects.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
            auditLevel: {
              type: "string",
              enum: CONFIGURABLE_AUDIT_LEVELS,
              description:
                "Minimum severity requested from the package manager. Defaults to low.",
            },
            productionOnly: {
              type: "boolean",
              description:
                "Exclude development dependencies where the detected package manager supports that audit filter.",
            },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: MAX_AUDIT_RESULTS,
              description: "Maximum advisory entries to include.",
            },
          },
        },
      },
      backingTool: "packages",
      riskLevel: "medium",
      execute: async (args, context) => {
        const auditLevel = coerceAuditLevel(args);
        const maxResults = coerceBoundedInteger(
          args,
          "maxResults",
          DEFAULT_AUDIT_RESULTS,
          MAX_AUDIT_RESULTS,
        );

        if (!auditLevel) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "audit_node_package_dependencies",
            "Expected `auditLevel` to be one of low, moderate, high, or critical.",
          );
        }

        if (maxResults === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "audit_node_package_dependencies",
            `Expected \`maxResults\` to be between 1 and ${MAX_AUDIT_RESULTS}.`,
          );
        }

        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const productionOnly =
            coerceBoolean(args, "productionOnly") ?? false;
          const managerArgs = auditCommandArgs(project, {
            auditLevel,
            productionOnly,
          });
          const result = await runPackageManager(
            project,
            managerArgs,
            PACKAGE_AUDIT_TIMEOUT_MS,
            auditAcceptedExitCodes(project),
          );
          const auditSummary = parsePackageAudit(result.stdout);
          const displayedEntries = auditSummary.entries.slice(0, maxResults);
          const entryLines = displayedEntries.map(formatAuditEntry);
          const output = [
            `Package: ${project.manifest.name ?? "(unnamed)"}`,
            `Manager: ${project.manager}`,
            `Audit level: ${auditLevel}`,
            `Production only: ${productionOnly ? "yes" : "no"}`,
            `Vulnerabilities: ${auditSummary.total}`,
            `Severity counts: ${formatAuditCounts(auditSummary.counts)}`,
            entryLines.length > 0
              ? entryLines.join("\n")
              : "No vulnerability entries were reported.",
            auditSummary.entries.length > maxResults
              ? `... truncated after ${maxResults} of ${auditSummary.entries.length} entries`
              : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "audit_node_package_dependencies",
              output: limitText(output),
            },
            sections: [
              {
                title: "Package audit",
                lines: [
                  `manager: ${project.manager}`,
                  `package root: ${project.packageRoot}`,
                  `audit level: ${auditLevel}`,
                  `production only: ${productionOnly ? "yes" : "no"}`,
                  `vulnerabilities: ${auditSummary.total}`,
                  `severity counts: ${formatAuditCounts(auditSummary.counts)}`,
                  `exit code: ${result.exitCode}`,
                ],
              },
              {
                title: "Audit advisories",
                lines:
                  entryLines.length > 0
                    ? [
                        ...entryLines,
                        ...(auditSummary.entries.length > maxResults
                          ? [
                              `... truncated after ${maxResults} of ${auditSummary.entries.length} entries`,
                            ]
                          : []),
                      ]
                    : ["No vulnerability entries were reported."],
              },
            ],
            traceLines: [
              `audit_node_package_dependencies(${project.manifest.name ?? "unnamed"}) -> ${auditSummary.total} vulnerabilities`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "audit_node_package_dependencies",
            error instanceof SyntaxError
              ? `Package manager returned audit data that could not be parsed as JSON: ${stringifyUnknown(error.message)}`
              : formatLocalCommandError("package audit failed", error),
          );
        }
      },
    },
    {
      spec: {
        name: "install_node_packages",
        description:
          "Install one or more registry package specs with the detected package manager. This mutates package.json, lockfiles, and usually node_modules; it never accepts local file, Git, or remote tarball specs.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            packages: {
              type: "array",
              minItems: 1,
              maxItems: MAX_PACKAGE_SPECS,
              items: { type: "string" },
              description:
                "Registry package specs such as react, @types/node, or vite@latest. Local file, Git, and remote tarball specs are rejected.",
            },
            dev: {
              type: "boolean",
              description: "Whether to save packages as development dependencies.",
            },
            exact: {
              type: "boolean",
              description: "Whether to save exact versions.",
            },
            lockfileOnly: {
              type: "boolean",
              description:
                "For npm and bun projects only, update lockfiles/package metadata without installing into node_modules.",
            },
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
          },
          required: ["packages"],
        },
      },
      backingTool: "packages",
      riskLevel: "high",
      execute: async (args, context) => {
        const packageSpecs = normalizePackageSpecs(args.packages);

        if (!packageSpecs) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "install_node_packages",
            "Expected 1-20 registry package specs without whitespace, option prefixes, local file paths, Git specs, or remote tarballs.",
          );
        }

        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const lockfileOnly = coerceBoolean(args, "lockfileOnly") ?? false;

          if (
            lockfileOnly &&
            project.manager !== "npm" &&
            project.manager !== "bun"
          ) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "install_node_packages",
              "`lockfileOnly` is currently supported for npm and bun projects only.",
            );
          }

          const managerArgs = installCommandArgs(project.manager, packageSpecs, {
            dev: coerceBoolean(args, "dev") ?? false,
            exact: coerceBoolean(args, "exact") ?? false,
            lockfileOnly,
          });
          const result = await runPackageManager(project, managerArgs);
          const output = [
            `Command: ${project.manager} ${managerArgs.join(" ")}`,
            `Exit code: ${result.exitCode}`,
            result.stdout ? `STDOUT:\n${result.stdout}` : undefined,
            result.stderr ? `STDERR:\n${result.stderr}` : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "install_node_packages",
              output: limitText(output),
            },
            sections: [
              {
                title: "Package install",
                lines: [
                  `manager: ${project.manager}`,
                  `package root: ${project.packageRoot}`,
                  `packages: ${packageSpecs.join(", ")}`,
                  `dev: ${coerceBoolean(args, "dev") === true ? "yes" : "no"}`,
                  `exact: ${coerceBoolean(args, "exact") === true ? "yes" : "no"}`,
                  `lockfile only: ${lockfileOnly ? "yes" : "no"}`,
                ],
              },
              createTextSection(
                "Install output",
                [result.stdout, result.stderr].filter(Boolean).join("\n\n") ||
                  "(no output)",
              ),
            ],
            traceLines: [
              `install_node_packages(${packageSpecs.map(compactTraceText).join(", ")}) -> exit ${result.exitCode}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "install_node_packages",
            formatLocalCommandError("package install failed", error),
          );
        }
      },
    },
  ];
};
