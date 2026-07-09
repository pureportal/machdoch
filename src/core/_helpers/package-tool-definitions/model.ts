export const PACKAGE_TIMEOUT_MS = 120_000;
export const PACKAGE_AUDIT_TIMEOUT_MS = 120_000;
export const PACKAGE_MAX_BUFFER_BYTES = 1_500_000;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
export const MAX_SCRIPT_TIMEOUT_MS = 300_000;
export const DEFAULT_OUTDATED_RESULTS = 25;
export const MAX_OUTDATED_RESULTS = 100;
export const DEFAULT_AUDIT_RESULTS = 25;
export const MAX_AUDIT_RESULTS = 100;
export const MAX_PACKAGE_SPECS = 20;
export const MAX_PACKAGE_SPEC_LENGTH = 220;
export const MAX_SCRIPT_ARGS = 40;
export const MAX_SCRIPT_ARG_LENGTH = 1_000;
export const MAX_WORKSPACE_PATTERNS = 50;
export const MAX_WORKSPACE_PATTERN_LENGTH = 220;
export const MAX_WORKSPACE_PACKAGES = 120;

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
export const NODE_PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export const AUDIT_SEVERITIES = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
] as const;
export const CONFIGURABLE_AUDIT_LEVELS = [
  "low",
  "moderate",
  "high",
  "critical",
] as const;
export const AUDIT_SEVERITY_RANK: Record<AuditSeverity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
export const IGNORED_WORKSPACE_DISCOVERY_DIRECTORIES = new Set([
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

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];
export type NodePackageManager = (typeof NODE_PACKAGE_MANAGERS)[number];
export type ManagerDetectionSource = "packageManager" | "lockfile" | "default";
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];
export type ConfigurableAuditLevel = (typeof CONFIGURABLE_AUDIT_LEVELS)[number];

export interface NodePackageProject {
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

export interface PackageManagerDetection {
  manager: NodePackageManager;
  source: ManagerDetectionSource;
  version?: string;
}

export interface PackageLockfileInfo {
  name: string;
  manager: NodePackageManager;
  lockfileVersion?: number;
  packageCount?: number;
}

export interface NodeWorkspacePackage {
  path: string;
  packageJsonPath: string;
  name?: string;
  version?: string;
  private?: boolean;
  scriptCount: number;
  dependencyCount: number;
}

export interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  packageManager?: string;
  scripts: Record<string, string>;
  dependencies: Record<DependencySection, Record<string, string>>;
  workspaces: string[];
}

export interface NodeOutdatedEntry {
  name: string;
  current?: string;
  wanted?: string;
  latest?: string;
  dependent?: string;
  location?: string;
  type?: string;
}

export interface PackageAuditEntry {
  name: string;
  severity?: AuditSeverity;
  title?: string;
  range?: string;
  via?: string;
  fixAvailable?: string;
  url?: string;
}

export interface PackageAuditSummary {
  counts: Record<AuditSeverity, number>;
  total: number;
  entries: PackageAuditEntry[];
}

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const firstStringField = (
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

export const parseJsonOrJsonLines = (output: string): unknown[] => {
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

