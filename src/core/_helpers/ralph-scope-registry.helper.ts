import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const RALPH_SCOPE_EVIDENCE_SCHEMA = "machdoch.ralph.scopeEvidence" as const;
export const RALPH_SCOPE_REGISTRY_SCHEMA = "machdoch.ralph.scopeRegistry" as const;
export const RALPH_SCOPE_REGISTRY_SCHEMA_VERSION = 1 as const;

export const RALPH_SCOPE_SELECTION_STRATEGIES = [
  "start-to-end",
  "round-robin",
  "random",
  "random-seeded",
  "least-recent",
  "least-validated",
  "priority",
  "risk-first",
  "ui-first",
] as const;

export type RalphScopeSelectionStrategy =
  (typeof RALPH_SCOPE_SELECTION_STRATEGIES)[number];
export type RalphScopeRegistryScopeStatus = "active" | "removed";
export type RalphScopeRegistryRisk = "low" | "medium" | "high";
export type RalphScopeRegistryKind =
  | "workspace"
  | "app"
  | "package"
  | "source-root"
  | "test"
  | "docs"
  | "config"
  | "module";

export interface RalphScopeEvidenceScope {
  id: string;
  title: string;
  kind: RalphScopeRegistryKind;
  paths: string[];
  globs: string[];
  tags: string[];
  priority: number;
  risk: RalphScopeRegistryRisk;
  fingerprint: string;
  evidence: string[];
}

export interface RalphScopeEvidenceDocument {
  schema: typeof RALPH_SCOPE_EVIDENCE_SCHEMA;
  schemaVersion: typeof RALPH_SCOPE_REGISTRY_SCHEMA_VERSION;
  generatedAt: string;
  workspaceRoot: string;
  rootPath: string;
  excludePaths: string[];
  scopes: RalphScopeEvidenceScope[];
}

export interface RalphScopeRegistryScope extends RalphScopeEvidenceScope {
  status: RalphScopeRegistryScopeStatus;
  discoveredAt: string;
  updatedAt: string;
  lastSelectedAt?: string | null;
  lastValidatedAt?: string | null;
  selectedCount: number;
  validatedCount: number;
  lastOutcome?: string | null;
}

export interface RalphScopeRegistrySelection {
  strategy: RalphScopeSelectionStrategy;
  cursor: number;
  cycle: number;
  seed?: string;
  currentScopeId?: string | null;
  completedScopeIds: string[];
}

export interface RalphScopeRegistryHistoryEntry {
  at: string;
  type: "registry-updated" | "scope-selected" | "scope-marked";
  scopeId?: string;
  cycle?: number;
  outcome?: string;
  summary?: string;
  added?: string[];
  updated?: string[];
  removed?: string[];
}

export interface RalphScopeRegistry {
  schema: typeof RALPH_SCOPE_REGISTRY_SCHEMA;
  schemaVersion: typeof RALPH_SCOPE_REGISTRY_SCHEMA_VERSION;
  flowAlias: string;
  updatedAt: string;
  selection: RalphScopeRegistrySelection;
  scopes: RalphScopeRegistryScope[];
  history: RalphScopeRegistryHistoryEntry[];
}

export interface RalphScopeRegistryUpdateResult {
  registry: RalphScopeRegistry;
  added: string[];
  updated: string[];
  removed: string[];
}

export interface RalphScopeRegistrySelectionResult {
  registry: RalphScopeRegistry;
  scope?: RalphScopeRegistryScope;
  scopeCluster?: RalphScopeRegistryScopeCluster;
  reusedCurrentScope: boolean;
  cycleStarted: boolean;
}

export interface RalphScopeRegistryScopeCluster {
  rootScopeId: string;
  scopeIds: string[];
  paths: string[];
  globs: string[];
  tags: string[];
  risk: RalphScopeRegistryRisk;
  rationale: string[];
}

export interface RalphScopeRegistryMarkResult {
  registry: RalphScopeRegistry;
  scope?: RalphScopeRegistryScope;
  cycleCompleted: boolean;
}

const DEFAULT_SCOPE_SCAN_EXCLUDE_PATHS = [
  ".git",
  ".machdoch",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "vendor",
  "generated",
  "out",
  ".venv",
  "venv",
] as const;

const COMMON_SOURCE_DIR_NAMES = new Set([
  "src",
  "app",
  "pages",
  "components",
  "lib",
  "core",
  "server",
  "client",
  "backend",
  "frontend",
  "api",
  "routes",
  "services",
  "domain",
  "features",
  "modules",
  "src-tauri",
]);

const COMMON_TEST_DIR_NAMES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "e2e",
  "integration",
]);

const COMMON_DOCS_DIR_NAMES = new Set(["docs", "doc", "documentation"]);
const COMMON_CONTAINER_DIR_NAMES = new Set([
  "apps",
  "packages",
  "crates",
  "services",
  "workspaces",
  "modules",
]);

const MANIFEST_FILE_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
  "tsconfig.json",
]);

const ROOT_CONFIG_FILE_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs",
  "vitest.config.ts",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

const HIGH_RISK_TOKENS = [
  "auth",
  "security",
  "session",
  "token",
  "payment",
  "billing",
  "permission",
  "secret",
  "crypto",
  "database",
  "migration",
  "ipc",
  "api",
  "server",
  "backend",
  "src-tauri",
] as const;

const MEDIUM_RISK_TOKENS = [
  "route",
  "service",
  "store",
  "state",
  "upload",
  "download",
  "config",
  "worker",
  "job",
] as const;

const normalizeRegistryPath = (path: string): string => {
  const normalized = path.replace(/\\/gu, "/").replace(/^\.\/+/u, "");

  return normalized.trim() ? normalized : ".";
};

const normalizePathList = (paths: readonly string[]): string[] => {
  return [...new Set(paths.map(normalizeRegistryPath).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const isRalphScopeSelectionStrategy = (
  value: unknown,
): value is RalphScopeSelectionStrategy => {
  return (
    typeof value === "string" &&
    RALPH_SCOPE_SELECTION_STRATEGIES.includes(
      value as RalphScopeSelectionStrategy,
    )
  );
};

export const normalizeRalphScopeSelectionStrategy = (
  value: unknown,
): RalphScopeSelectionStrategy | undefined => {
  if (!isRalphScopeSelectionStrategy(value)) {
    return undefined;
  }

  return value;
};

export const createDefaultRalphScopeRegistryPath = (flowAlias: string): string => {
  const safeAlias = normalizeScopeId(flowAlias || "default");

  return `.machdoch/ralph/scope-registry/${safeAlias}.scope-registry.json`;
};

export const parseRalphScopeExcludePaths = (
  value: string | undefined,
): string[] => {
  const configured = value
    ?.split(/[\n,]/u)
    .map((entry) => normalizeRegistryPath(entry.trim()))
    .filter(Boolean) ?? [];

  return normalizePathList([...DEFAULT_SCOPE_SCAN_EXCLUDE_PATHS, ...configured]);
};

export const isResolvedPathInside = (path: string, root: string): boolean => {
  const relativePath = relative(resolve(root), resolve(path));

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

export const createRalphScopeRegistryMarkdownPath = (
  registryPath: string,
): string => {
  return registryPath.replace(/\.json$/iu, ".md");
};

const getPathSegments = (path: string): string[] => {
  return normalizeRegistryPath(path).split("/").filter((segment) => segment !== ".");
};

export const normalizeScopeId = (value: string): string => {
  const normalized = normalizeRegistryPath(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);

  return normalized || "workspace-root";
};

const titleFromPath = (path: string): string => {
  const segments = getPathSegments(path);
  const last = segments.at(-1) ?? "workspace";
  const words = last
    .replace(/[-_]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);

  return words.length > 0
    ? words
        .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
        .join(" ")
    : "Workspace";
};

const hashStableValue = (value: unknown): string => {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
};

const determineRisk = (
  path: string,
  tags: readonly string[],
): RalphScopeRegistryRisk => {
  const searchable = `${path} ${tags.join(" ")}`.toLowerCase();

  if (HIGH_RISK_TOKENS.some((token) => searchable.includes(token))) {
    return "high";
  }

  if (MEDIUM_RISK_TOKENS.some((token) => searchable.includes(token))) {
    return "medium";
  }

  return "low";
};

const determinePriority = (
  kind: RalphScopeRegistryKind,
  risk: RalphScopeRegistryRisk,
): number => {
  const kindScore: Record<RalphScopeRegistryKind, number> = {
    workspace: 55,
    app: 80,
    package: 72,
    "source-root": 70,
    module: 66,
    config: 62,
    test: 46,
    docs: 28,
  };
  const riskScore: Record<RalphScopeRegistryRisk, number> = {
    high: 20,
    medium: 10,
    low: 0,
  };

  return Math.min(100, kindScore[kind] + riskScore[risk]);
};

const getDirectoryKind = (
  relPath: string,
  fileNames: readonly string[],
): RalphScopeRegistryKind | undefined => {
  const segments = getPathSegments(relPath);
  const baseName = segments.at(-1) ?? "";
  const parentName = segments.at(-2) ?? "";
  const hasManifest = fileNames.some((fileName) => MANIFEST_FILE_NAMES.has(fileName));

  if (COMMON_DOCS_DIR_NAMES.has(baseName)) {
    return "docs";
  }

  if (COMMON_TEST_DIR_NAMES.has(baseName)) {
    return "test";
  }

  if (hasManifest && ["apps", "services"].includes(parentName)) {
    return "app";
  }

  if (COMMON_CONTAINER_DIR_NAMES.has(parentName)) {
    return "package";
  }

  if (hasManifest) {
    return "package";
  }

  if (COMMON_SOURCE_DIR_NAMES.has(baseName)) {
    return "source-root";
  }

  return undefined;
};

const createDirectoryEvidenceScope = (
  relPath: string,
  kind: RalphScopeRegistryKind,
  fileNames: readonly string[],
): RalphScopeEvidenceScope => {
  const normalizedPath = normalizeRegistryPath(relPath);
  const evidence = fileNames
    .filter(
      (fileName) =>
        MANIFEST_FILE_NAMES.has(fileName) ||
        fileName.endsWith(".config.ts") ||
        fileName.endsWith(".config.js") ||
        fileName.endsWith(".config.mjs"),
    )
    .slice(0, 12)
    .map((fileName) =>
      normalizedPath === "." ? fileName : `${normalizedPath}/${fileName}`,
    );
  const tags = normalizePathList([
    kind,
    ...getPathSegments(normalizedPath).filter((segment) => segment.length > 1),
  ]);
  const risk = determineRisk(normalizedPath, tags);
  const paths = [normalizedPath];
  const globs = [`${normalizedPath === "." ? "" : `${normalizedPath}/`}**/*`];

  return {
    id: normalizeScopeId(normalizedPath),
    title: titleFromPath(normalizedPath),
    kind,
    paths,
    globs,
    tags,
    priority: determinePriority(kind, risk),
    risk,
    fingerprint: hashStableValue({ paths, globs, tags, evidence }),
    evidence,
  };
};

const createConfigEvidenceScope = (
  fileNames: readonly string[],
): RalphScopeEvidenceScope | undefined => {
  const paths = normalizePathList(
    fileNames.filter((fileName) => ROOT_CONFIG_FILE_NAMES.has(fileName)),
  );

  if (paths.length === 0) {
    return undefined;
  }

  const tags = ["config", "workspace"];
  const risk = determineRisk(paths.join(" "), tags);

  return {
    id: "repository-configuration",
    title: "Repository Configuration",
    kind: "config",
    paths,
    globs: paths,
    tags,
    priority: determinePriority("config", risk),
    risk,
    fingerprint: hashStableValue({ paths, tags }),
    evidence: paths,
  };
};

const isExcludedScopePath = (
  relPath: string,
  excludePaths: readonly string[],
): boolean => {
  const normalizedPath = normalizeRegistryPath(relPath);

  return excludePaths.some((excludePath) => {
    const normalizedExclude = normalizeRegistryPath(excludePath);
    const nestedExclude = `/${normalizedExclude}/`;

    return (
      normalizedPath === normalizedExclude ||
      normalizedPath.startsWith(`${normalizedExclude}/`) ||
      normalizedPath.endsWith(`/${normalizedExclude}`) ||
      normalizedPath.includes(nestedExclude)
    );
  });
};

const addScopeEvidence = (
  scopes: Map<string, RalphScopeEvidenceScope>,
  scope: RalphScopeEvidenceScope | undefined,
): void => {
  if (!scope) {
    return;
  }

  const existing = scopes.get(scope.id);
  if (!existing) {
    scopes.set(scope.id, scope);
    return;
  }

  const paths = normalizePathList([...existing.paths, ...scope.paths]);
  const globs = normalizePathList([...existing.globs, ...scope.globs]);
  const tags = normalizePathList([...existing.tags, ...scope.tags]);
  const evidence = normalizePathList([...existing.evidence, ...scope.evidence]);

  scopes.set(scope.id, {
    ...existing,
    paths,
    globs,
    tags,
    evidence,
    priority: Math.max(existing.priority, scope.priority),
    risk: existing.risk === "high" || scope.risk === "high"
      ? "high"
      : existing.risk === "medium" || scope.risk === "medium"
        ? "medium"
        : "low",
    fingerprint: hashStableValue({ paths, globs, tags, evidence }),
  });
};

export const discoverRalphScopeEvidence = async (
  workspaceRoot: string,
  options: {
    rootPath?: string;
    excludePaths?: string[];
    maxDepth?: number;
    maxResults?: number;
    now?: string;
  } = {},
): Promise<RalphScopeEvidenceDocument> => {
  const rootPath = normalizeRegistryPath(options.rootPath ?? ".");
  const scanRoot = resolve(workspaceRoot, rootPath);
  const excludePaths = options.excludePaths ?? parseRalphScopeExcludePaths(undefined);
  const maxDepth = Math.max(0, Math.trunc(options.maxDepth ?? 4));
  const maxResults = Math.max(1, Math.trunc(options.maxResults ?? 200));
  const scopes = new Map<string, RalphScopeEvidenceScope>();
  const queue: Array<{ absPath: string; relPath: string; depth: number }> = [
    { absPath: scanRoot, relPath: rootPath, depth: 0 },
  ];

  while (queue.length > 0 && scopes.size < maxResults) {
    const current = queue.shift();
    if (!current || isExcludedScopePath(current.relPath, excludePaths)) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(current.absPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const fileNames = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const dirNames = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    if (current.relPath === ".") {
      addScopeEvidence(scopes, createConfigEvidenceScope(fileNames));
    } else {
      const kind = getDirectoryKind(current.relPath, fileNames);
      if (kind) {
        addScopeEvidence(
          scopes,
          createDirectoryEvidenceScope(current.relPath, kind, fileNames),
        );
      }
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    for (const dirName of dirNames) {
      const relPath =
        current.relPath === "." ? dirName : `${current.relPath}/${dirName}`;
      if (!isExcludedScopePath(relPath, excludePaths)) {
        queue.push({
          absPath: resolve(current.absPath, dirName),
          relPath,
          depth: current.depth + 1,
        });
      }
    }
  }

  if (scopes.size === 0) {
    addScopeEvidence(
      scopes,
      createDirectoryEvidenceScope(rootPath, "workspace", []),
    );
  }

  return {
    schema: RALPH_SCOPE_EVIDENCE_SCHEMA,
    schemaVersion: RALPH_SCOPE_REGISTRY_SCHEMA_VERSION,
    generatedAt: options.now ?? new Date().toISOString(),
    workspaceRoot: resolve(workspaceRoot),
    rootPath,
    excludePaths: [...excludePaths],
    scopes: [...scopes.values()].sort((a, b) => {
      const priorityDelta = b.priority - a.priority;

      return priorityDelta === 0 ? a.id.localeCompare(b.id) : priorityDelta;
    }),
  };
};

const createDefaultRegistry = (
  flowAlias: string,
  strategy: RalphScopeSelectionStrategy,
  now: string,
): RalphScopeRegistry => {
  return {
    schema: RALPH_SCOPE_REGISTRY_SCHEMA,
    schemaVersion: RALPH_SCOPE_REGISTRY_SCHEMA_VERSION,
    flowAlias,
    updatedAt: now,
    selection: {
      strategy,
      cursor: 0,
      cycle: 1,
      seed: flowAlias,
      currentScopeId: null,
      completedScopeIds: [],
    },
    scopes: [],
    history: [],
  };
};

const coerceStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const coerceScopeRisk = (value: unknown): RalphScopeRegistryRisk => {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
};

const coerceScopeKind = (value: unknown): RalphScopeRegistryKind => {
  return value === "workspace" ||
    value === "app" ||
    value === "package" ||
    value === "source-root" ||
    value === "test" ||
    value === "docs" ||
    value === "config" ||
    value === "module"
    ? value
    : "module";
};

const coerceScopeStatus = (value: unknown): RalphScopeRegistryScopeStatus => {
  return value === "removed" ? "removed" : "active";
};

const normalizeRegistryScope = (
  value: unknown,
  now: string,
): RalphScopeRegistryScope | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const paths = normalizePathList(coerceStringArray(value.paths));
  if (paths.length === 0) {
    return undefined;
  }

  const id = typeof value.id === "string" ? normalizeScopeId(value.id) : normalizeScopeId(paths[0] ?? "scope");
  const tags = normalizePathList(coerceStringArray(value.tags));
  const evidence = normalizePathList(coerceStringArray(value.evidence));
  const globs = normalizePathList(coerceStringArray(value.globs));
  const kind = coerceScopeKind(value.kind);
  const risk = coerceScopeRisk(value.risk);

  return {
    id,
    title: typeof value.title === "string" && value.title.trim()
      ? value.title
      : titleFromPath(paths[0] ?? id),
    kind,
    status: coerceScopeStatus(value.status),
    paths,
    globs: globs.length > 0 ? globs : paths,
    tags,
    priority: typeof value.priority === "number" && Number.isFinite(value.priority)
      ? Math.max(0, Math.min(100, Math.trunc(value.priority)))
      : determinePriority(kind, risk),
    risk,
    fingerprint: typeof value.fingerprint === "string" && value.fingerprint.trim()
      ? value.fingerprint
      : hashStableValue({ paths, globs, tags, evidence }),
    evidence,
    discoveredAt: typeof value.discoveredAt === "string" ? value.discoveredAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    lastSelectedAt:
      typeof value.lastSelectedAt === "string" ? value.lastSelectedAt : null,
    lastValidatedAt:
      typeof value.lastValidatedAt === "string" ? value.lastValidatedAt : null,
    selectedCount:
      typeof value.selectedCount === "number" && Number.isFinite(value.selectedCount)
        ? Math.max(0, Math.trunc(value.selectedCount))
        : 0,
    validatedCount:
      typeof value.validatedCount === "number" && Number.isFinite(value.validatedCount)
        ? Math.max(0, Math.trunc(value.validatedCount))
        : 0,
    lastOutcome: typeof value.lastOutcome === "string" ? value.lastOutcome : null,
  };
};

export const parseRalphScopeRegistry = (
  value: unknown,
  options: {
    flowAlias: string;
    strategy: RalphScopeSelectionStrategy;
    now?: string;
  },
): RalphScopeRegistry => {
  const now = options.now ?? new Date().toISOString();
  if (!isRecord(value)) {
    return createDefaultRegistry(options.flowAlias, options.strategy, now);
  }

  const selectionRecord = isRecord(value.selection) ? value.selection : {};
  const strategy =
    normalizeRalphScopeSelectionStrategy(selectionRecord.strategy) ??
    options.strategy;
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.flatMap((scope): RalphScopeRegistryScope[] => {
        const normalized = normalizeRegistryScope(scope, now);

        return normalized ? [normalized] : [];
      })
    : [];
  const activeIds = new Set(
    scopes
      .filter((scope) => scope.status === "active")
      .map((scope) => scope.id),
  );
  const currentScopeId =
    typeof selectionRecord.currentScopeId === "string" &&
    activeIds.has(selectionRecord.currentScopeId)
      ? selectionRecord.currentScopeId
      : null;

  return {
    schema: RALPH_SCOPE_REGISTRY_SCHEMA,
    schemaVersion: RALPH_SCOPE_REGISTRY_SCHEMA_VERSION,
    flowAlias:
      typeof value.flowAlias === "string" && value.flowAlias.trim()
        ? value.flowAlias
        : options.flowAlias,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    selection: {
      strategy,
      cursor:
        typeof selectionRecord.cursor === "number" && Number.isFinite(selectionRecord.cursor)
          ? Math.max(0, Math.trunc(selectionRecord.cursor))
          : 0,
      cycle:
        typeof selectionRecord.cycle === "number" && Number.isFinite(selectionRecord.cycle)
          ? Math.max(1, Math.trunc(selectionRecord.cycle))
          : 1,
      seed:
        typeof selectionRecord.seed === "string" && selectionRecord.seed.trim()
          ? selectionRecord.seed
          : options.flowAlias,
      currentScopeId,
      completedScopeIds: coerceStringArray(selectionRecord.completedScopeIds)
        .map(normalizeScopeId)
        .filter((scopeId) => activeIds.has(scopeId)),
    },
    scopes,
    history: Array.isArray(value.history)
      ? value.history
          .filter(isRecord)
          .map((entry): RalphScopeRegistryHistoryEntry => {
            const type: RalphScopeRegistryHistoryEntry["type"] =
              entry.type === "scope-selected" || entry.type === "scope-marked"
                ? entry.type
                : "registry-updated";

            return {
              at: typeof entry.at === "string" ? entry.at : now,
              type,
              ...(typeof entry.scopeId === "string"
                ? { scopeId: normalizeScopeId(entry.scopeId) }
                : {}),
              ...(typeof entry.cycle === "number" ? { cycle: entry.cycle } : {}),
              ...(typeof entry.outcome === "string"
                ? { outcome: entry.outcome }
                : {}),
              ...(typeof entry.summary === "string"
                ? { summary: entry.summary }
                : {}),
              ...(Array.isArray(entry.added)
                ? { added: coerceStringArray(entry.added) }
                : {}),
              ...(Array.isArray(entry.updated)
                ? { updated: coerceStringArray(entry.updated) }
                : {}),
              ...(Array.isArray(entry.removed)
                ? { removed: coerceStringArray(entry.removed) }
                : {}),
            };
          })
          .slice(-200)
      : [],
  };
};

export const parseRalphScopeEvidence = (
  value: unknown,
): RalphScopeEvidenceDocument | undefined => {
  if (!isRecord(value) || !Array.isArray(value.scopes)) {
    return undefined;
  }

  const now =
    typeof value.generatedAt === "string"
      ? value.generatedAt
      : new Date().toISOString();
  const scopes = value.scopes.flatMap((scope): RalphScopeEvidenceScope[] => {
    const normalized = normalizeRegistryScope(scope, now);

    if (!normalized) {
      return [];
    }

    return [
      {
        id: normalized.id,
        title: normalized.title,
        kind: normalized.kind,
        paths: normalized.paths,
        globs: normalized.globs,
        tags: normalized.tags,
        priority: normalized.priority,
        risk: normalized.risk,
        fingerprint: normalized.fingerprint,
        evidence: normalized.evidence,
      },
    ];
  });

  return {
    schema: RALPH_SCOPE_EVIDENCE_SCHEMA,
    schemaVersion: RALPH_SCOPE_REGISTRY_SCHEMA_VERSION,
    generatedAt: now,
    workspaceRoot: typeof value.workspaceRoot === "string" ? value.workspaceRoot : "",
    rootPath: typeof value.rootPath === "string" ? value.rootPath : ".",
    excludePaths: coerceStringArray(value.excludePaths),
    scopes,
  };
};

const appendHistory = (
  registry: RalphScopeRegistry,
  entry: RalphScopeRegistryHistoryEntry,
): RalphScopeRegistry => {
  return {
    ...registry,
    history: [...registry.history, entry].slice(-200),
  };
};

export const updateRalphScopeRegistryFromEvidence = (
  existingRegistry: RalphScopeRegistry,
  evidence: RalphScopeEvidenceDocument,
  options: {
    flowAlias: string;
    strategy: RalphScopeSelectionStrategy;
    now?: string;
  },
): RalphScopeRegistryUpdateResult => {
  const now = options.now ?? new Date().toISOString();
  const registry: RalphScopeRegistry = {
    ...existingRegistry,
    flowAlias: options.flowAlias,
    updatedAt: now,
    selection: {
      ...existingRegistry.selection,
      strategy: options.strategy,
      currentScopeId: existingRegistry.selection.currentScopeId ?? null,
    },
  };
  const evidenceById = new Map(evidence.scopes.map((scope) => [scope.id, scope]));
  const existingById = new Map(registry.scopes.map((scope) => [scope.id, scope]));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const nextScopes: RalphScopeRegistryScope[] = [];

  for (const scope of evidence.scopes) {
    const existing = existingById.get(scope.id);
    if (!existing) {
      added.push(scope.id);
      nextScopes.push({
        ...scope,
        status: "active",
        discoveredAt: now,
        updatedAt: now,
        lastSelectedAt: null,
        lastValidatedAt: null,
        selectedCount: 0,
        validatedCount: 0,
        lastOutcome: null,
      });
      continue;
    }

    const changed =
      existing.fingerprint !== scope.fingerprint ||
      existing.status !== "active" ||
      JSON.stringify(existing.paths) !== JSON.stringify(scope.paths) ||
      JSON.stringify(existing.globs) !== JSON.stringify(scope.globs);

    if (changed) {
      updated.push(scope.id);
    }

    nextScopes.push({
      ...existing,
      ...scope,
      status: "active",
      discoveredAt: existing.discoveredAt,
      updatedAt: changed ? now : existing.updatedAt,
      selectedCount: existing.selectedCount,
      validatedCount: existing.validatedCount,
      lastSelectedAt: existing.lastSelectedAt ?? null,
      lastValidatedAt: existing.lastValidatedAt ?? null,
      lastOutcome: existing.lastOutcome ?? null,
    });
  }

  for (const existing of registry.scopes) {
    if (evidenceById.has(existing.id)) {
      continue;
    }

    if (existing.status === "active") {
      removed.push(existing.id);
    }

    nextScopes.push({
      ...existing,
      status: "removed",
      updatedAt: existing.status === "active" ? now : existing.updatedAt,
    });
  }

  const activeIds = new Set(
    nextScopes.filter((scope) => scope.status === "active").map((scope) => scope.id),
  );
  const nextRegistry = appendHistory(
    {
      ...registry,
      updatedAt: now,
      scopes: nextScopes.sort((a, b) => {
        if (a.status !== b.status) {
          return a.status === "active" ? -1 : 1;
        }

        const priorityDelta = b.priority - a.priority;

        return priorityDelta === 0 ? a.id.localeCompare(b.id) : priorityDelta;
      }),
      selection: {
        ...registry.selection,
        completedScopeIds: registry.selection.completedScopeIds.filter((scopeId) =>
          activeIds.has(scopeId),
        ),
        currentScopeId:
          registry.selection.currentScopeId &&
          activeIds.has(registry.selection.currentScopeId)
            ? registry.selection.currentScopeId
            : null,
      },
    },
    {
      at: now,
      type: "registry-updated",
      added,
      updated,
      removed,
      cycle: registry.selection.cycle,
    },
  );

  return { registry: nextRegistry, added, updated, removed };
};

const getActiveScopes = (
  registry: RalphScopeRegistry,
): RalphScopeRegistryScope[] => {
  return registry.scopes.filter((scope) => scope.status === "active");
};

const riskRank: Record<RalphScopeRegistryRisk, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const firstPathSegment = (path: string): string => {
  return getPathSegments(path)[0] ?? "";
};

const pathsAreRelated = (a: string, b: string): boolean => {
  const left = normalizeRegistryPath(a);
  const right = normalizeRegistryPath(b);

  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
};

const countSharedTerms = (
  left: readonly string[],
  right: readonly string[],
): number => {
  const leftTerms = new Set(left.map((term) => term.toLowerCase()));

  return right.filter((term) => leftTerms.has(term.toLowerCase())).length;
};

const scoreRelatedScope = (
  selected: RalphScopeRegistryScope,
  candidate: RalphScopeRegistryScope,
): { score: number; rationale: string[] } => {
  const rationale: string[] = [];
  let score = 0;

  if (
    selected.paths.some((selectedPath) =>
      candidate.paths.some((candidatePath) =>
        pathsAreRelated(selectedPath, candidatePath),
      ),
    )
  ) {
    score += 80;
    rationale.push("path relationship");
  }

  const selectedPrefixes = new Set(selected.paths.map(firstPathSegment).filter(Boolean));
  const sharedTopLevel = candidate.paths.some((path) =>
    selectedPrefixes.has(firstPathSegment(path)),
  );
  if (sharedTopLevel) {
    score += 42;
    rationale.push("same top-level area");
  }

  const sharedTags = countSharedTerms(selected.tags, candidate.tags);
  if (sharedTags > 0) {
    score += sharedTags * 8;
    rationale.push(`${sharedTags} shared tag${sharedTags === 1 ? "" : "s"}`);
  }

  if (
    candidate.kind === "test" &&
    ["app", "package", "source-root", "module"].includes(selected.kind)
  ) {
    score += sharedTopLevel ? 36 : 18;
    rationale.push("adjacent tests");
  }

  if (candidate.kind === "config" && selected.kind !== "config") {
    score += selected.risk === "high" ? 34 : 24;
    rationale.push("shared project configuration");
  }

  if (candidate.kind === "docs" && sharedTopLevel) {
    score += 18;
    rationale.push("adjacent documentation");
  }

  return { score, rationale };
};

const createScopeCluster = (
  registry: RalphScopeRegistry,
  selectedScope: RalphScopeRegistryScope,
): RalphScopeRegistryScopeCluster => {
  const relatedScopes = getActiveScopes(registry)
    .filter((scope) => scope.id !== selectedScope.id)
    .map((scope) => ({ scope, relation: scoreRelatedScope(selectedScope, scope) }))
    .filter((entry) => entry.relation.score >= 32)
    .sort((a, b) => {
      const scoreDelta = b.relation.score - a.relation.score;

      return scoreDelta === 0
        ? a.scope.id.localeCompare(b.scope.id)
        : scoreDelta;
    })
    .slice(0, 3);
  const scopes = [selectedScope, ...relatedScopes.map((entry) => entry.scope)];
  const paths = normalizePathList(scopes.flatMap((scope) => scope.paths)).slice(0, 24);
  const globs = normalizePathList(scopes.flatMap((scope) => scope.globs)).slice(0, 24);
  const tags = normalizePathList(scopes.flatMap((scope) => scope.tags)).slice(0, 36);
  const risk = scopes.reduce<RalphScopeRegistryRisk>(
    (current, scope) => (riskRank[scope.risk] > riskRank[current] ? scope.risk : current),
    selectedScope.risk,
  );
  const rationale = [
    `${selectedScope.id}: selected scope`,
    ...relatedScopes.map(
      (entry) =>
        `${entry.scope.id}: ${entry.relation.rationale.join(", ") || "related scope"}`,
    ),
  ];

  return {
    rootScopeId: selectedScope.id,
    scopeIds: scopes.map((scope) => scope.id),
    paths,
    globs,
    tags,
    risk,
    rationale,
  };
};

const compareNullableIsoDates = (a?: string | null, b?: string | null): number => {
  if (!a && !b) {
    return 0;
  }

  if (!a) {
    return -1;
  }

  if (!b) {
    return 1;
  }

  return a.localeCompare(b);
};

const UI_SCOPE_TERMS = new Set([
  "app",
  "apps",
  "asset",
  "assets",
  "astro",
  "client",
  "component",
  "components",
  "css",
  "design",
  "docs",
  "frontend",
  "html",
  "layout",
  "layouts",
  "mobile",
  "openapi",
  "page",
  "pages",
  "public",
  "rapidoc",
  "responsive",
  "route",
  "routes",
  "screen",
  "screens",
  "scss",
  "style",
  "styles",
  "svelte",
  "swagger",
  "tailwind",
  "theme",
  "themes",
  "ui",
  "ux",
  "view",
  "views",
  "vue",
  "web",
]);

const NON_UI_SCOPE_TERMS = new Set([
  "api",
  "auth",
  "backend",
  "database",
  "db",
  "ipc",
  "job",
  "migration",
  "queue",
  "server",
  "service",
  "services",
  "token",
  "worker",
]);

const UI_EVIDENCE_EXTENSIONS = [
  ".astro",
  ".css",
  ".html",
  ".jsx",
  ".less",
  ".scss",
  ".svelte",
  ".tsx",
  ".vue",
] as const;

const getScopeTerms = (scope: RalphScopeRegistryScope): Set<string> => {
  return new Set(
    [
      scope.id,
      scope.title,
      scope.kind,
      ...scope.paths,
      ...scope.globs,
      ...scope.tags,
      ...scope.evidence,
    ]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean),
  );
};

const getUiEvidenceExtensionCount = (scope: RalphScopeRegistryScope): number => {
  return scope.evidence.filter((entry) =>
    UI_EVIDENCE_EXTENSIONS.some((extension) =>
      entry.toLowerCase().endsWith(extension),
    ),
  ).length;
};

const getUiFirstScopeScore = (scope: RalphScopeRegistryScope): number => {
  const terms = getScopeTerms(scope);
  const kindScore: Record<RalphScopeRegistryKind, number> = {
    app: 30,
    "source-root": 24,
    module: 18,
    package: 12,
    workspace: 8,
    docs: 6,
    config: -8,
    test: -12,
  };
  const positiveTermScore = [...UI_SCOPE_TERMS].reduce(
    (score, term) => score + (terms.has(term) ? 12 : 0),
    0,
  );
  const negativeTermScore = [...NON_UI_SCOPE_TERMS].reduce(
    (score, term) => score + (terms.has(term) ? 14 : 0),
    0,
  );

  return (
    kindScore[scope.kind] +
    positiveTermScore +
    getUiEvidenceExtensionCount(scope) * 10 -
    negativeTermScore +
    scope.priority / 100
  );
};

const compareUiFirstScopes = (
  a: RalphScopeRegistryScope,
  b: RalphScopeRegistryScope,
): number => {
  const scoreDelta = getUiFirstScopeScore(b) - getUiFirstScopeScore(a);

  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const validatedDelta = a.validatedCount - b.validatedCount;
  if (validatedDelta !== 0) {
    return validatedDelta;
  }

  const priorityDelta = b.priority - a.priority;

  return priorityDelta === 0 ? a.id.localeCompare(b.id) : priorityDelta;
};

const seededIndex = (
  scopes: readonly RalphScopeRegistryScope[],
  seed: string,
  cycle: number,
): number => {
  const hash = createHash("sha256")
    .update(`${seed}:${cycle}:${scopes.map((scope) => scope.id).join("|")}`)
    .digest("hex")
    .slice(0, 8);

  return Number.parseInt(hash, 16) % Math.max(1, scopes.length);
};

const pickScope = (
  scopes: RalphScopeRegistryScope[],
  registry: RalphScopeRegistry,
  strategy: RalphScopeSelectionStrategy,
): { scope: RalphScopeRegistryScope; cursor: number } => {
  switch (strategy) {
    case "least-recent": {
      const sorted = [...scopes].sort((a, b) => {
        const selectedDelta = compareNullableIsoDates(a.lastSelectedAt, b.lastSelectedAt);

        return selectedDelta === 0 ? a.id.localeCompare(b.id) : selectedDelta;
      });

      return { scope: sorted[0]!, cursor: registry.selection.cursor };
    }
    case "least-validated": {
      const sorted = [...scopes].sort((a, b) => {
        const validatedDelta = a.validatedCount - b.validatedCount;

        return validatedDelta === 0 ? a.id.localeCompare(b.id) : validatedDelta;
      });

      return { scope: sorted[0]!, cursor: registry.selection.cursor };
    }
    case "priority": {
      const sorted = [...scopes].sort((a, b) => {
        const priorityDelta = b.priority - a.priority;

        return priorityDelta === 0 ? a.id.localeCompare(b.id) : priorityDelta;
      });

      return { scope: sorted[0]!, cursor: registry.selection.cursor };
    }
    case "risk-first": {
      const sorted = [...scopes].sort((a, b) => {
        const riskDelta = riskRank[b.risk] - riskRank[a.risk];

        return riskDelta === 0 ? a.id.localeCompare(b.id) : riskDelta;
      });

      return { scope: sorted[0]!, cursor: registry.selection.cursor };
    }
    case "ui-first": {
      const sorted = [...scopes].sort(compareUiFirstScopes);

      return { scope: sorted[0]!, cursor: registry.selection.cursor };
    }
    case "random": {
      const index = Math.floor(Math.random() * scopes.length);

      return { scope: scopes[index]!, cursor: registry.selection.cursor };
    }
    case "random-seeded": {
      const index = seededIndex(
        scopes,
        registry.selection.seed ?? registry.flowAlias,
        registry.selection.cycle,
      );

      return { scope: scopes[index]!, cursor: registry.selection.cursor };
    }
    case "round-robin": {
      const activeScopes = getActiveScopes(registry);
      const cursor = registry.selection.cursor % Math.max(1, activeScopes.length);
      const ordered = [
        ...activeScopes.slice(cursor),
        ...activeScopes.slice(0, cursor),
      ].filter((scope) => scopes.some((candidate) => candidate.id === scope.id));
      const scope = ordered[0] ?? scopes[0]!;
      const nextCursor =
        activeScopes.findIndex((candidate) => candidate.id === scope.id) + 1;

      return {
        scope,
        cursor: nextCursor >= activeScopes.length ? 0 : nextCursor,
      };
    }
    case "start-to-end":
      return { scope: scopes[0]!, cursor: registry.selection.cursor };
  }
};

export const selectRalphScopeFromRegistry = (
  registry: RalphScopeRegistry,
  options: {
    strategy?: RalphScopeSelectionStrategy;
    now?: string;
    forceNew?: boolean;
  } = {},
): RalphScopeRegistrySelectionResult => {
  const now = options.now ?? new Date().toISOString();
  const strategy = options.strategy ?? registry.selection.strategy;
  const activeScopes = getActiveScopes(registry);
  const currentScope = activeScopes.find(
    (scope) => scope.id === registry.selection.currentScopeId,
  );

  if (currentScope && !options.forceNew) {
    return {
      registry: {
        ...registry,
        selection: { ...registry.selection, strategy },
      },
      scope: currentScope,
      scopeCluster: createScopeCluster(registry, currentScope),
      reusedCurrentScope: true,
      cycleStarted: false,
    };
  }

  if (activeScopes.length === 0) {
    return {
      registry: {
        ...registry,
        selection: { ...registry.selection, strategy, currentScopeId: null },
      },
      reusedCurrentScope: false,
      cycleStarted: false,
    };
  }

  const completedIds = new Set(registry.selection.completedScopeIds);
  let candidateScopes = activeScopes.filter((scope) => !completedIds.has(scope.id));
  let cycle = registry.selection.cycle;
  let cycleStarted = false;

  if (candidateScopes.length === 0) {
    candidateScopes = activeScopes;
    cycle += 1;
    cycleStarted = true;
  }

  const picked = pickScope(candidateScopes, registry, strategy);
  const scopes = registry.scopes.map((scope) =>
    scope.id === picked.scope.id
      ? {
          ...scope,
          lastSelectedAt: now,
          selectedCount: scope.selectedCount + 1,
        }
      : scope,
  );
  const selectedScope = scopes.find((scope) => scope.id === picked.scope.id);
  const nextRegistry = appendHistory(
    {
      ...registry,
      updatedAt: now,
      scopes,
      selection: {
        ...registry.selection,
        strategy,
        cursor: picked.cursor,
        cycle,
        currentScopeId: picked.scope.id,
        completedScopeIds: cycleStarted ? [] : registry.selection.completedScopeIds,
      },
    },
    {
      at: now,
      type: "scope-selected",
      scopeId: picked.scope.id,
      cycle,
      summary: `${picked.scope.title} selected with ${strategy}.`,
    },
  );

  return selectedScope
    ? {
    registry: nextRegistry,
    scope: selectedScope,
    scopeCluster: createScopeCluster(nextRegistry, selectedScope),
    reusedCurrentScope: false,
    cycleStarted,
      }
    : {
        registry: nextRegistry,
        reusedCurrentScope: false,
        cycleStarted,
      };
};

export const markRalphScopeRegistryResult = (
  registry: RalphScopeRegistry,
  options: {
    scopeId?: string;
    outcome?: string;
    summary?: string;
    now?: string;
  } = {},
): RalphScopeRegistryMarkResult => {
  const now = options.now ?? new Date().toISOString();
  const scopeId = normalizeScopeId(
    options.scopeId ?? registry.selection.currentScopeId ?? "",
  );
  const activeScopes = getActiveScopes(registry);
  const scope = activeScopes.find((candidate) => candidate.id === scopeId);

  if (!scope) {
    return { registry, cycleCompleted: false };
  }

  const completedScopeIds = [
    ...new Set([...registry.selection.completedScopeIds, scopeId]),
  ];
  const activeScopeIds = activeScopes.map((candidate) => candidate.id);
  const cycleCompleted = activeScopeIds.every((activeScopeId) =>
    completedScopeIds.includes(activeScopeId),
  );
  const nextCompletedScopeIds = cycleCompleted ? [] : completedScopeIds;
  const outcome = options.outcome?.trim() || "completed";
  const scopes = registry.scopes.map((candidate) =>
    candidate.id === scopeId
      ? {
          ...candidate,
          lastValidatedAt: now,
          validatedCount: candidate.validatedCount + 1,
          lastOutcome: outcome,
        }
      : candidate,
  );
  const markedScope = scopes.find((candidate) => candidate.id === scopeId);
  const nextRegistry = appendHistory(
    {
      ...registry,
      updatedAt: now,
      scopes,
      selection: {
        ...registry.selection,
        currentScopeId: null,
        completedScopeIds: nextCompletedScopeIds,
        cycle: cycleCompleted
          ? registry.selection.cycle + 1
          : registry.selection.cycle,
      },
    },
    {
      at: now,
      type: "scope-marked",
      scopeId,
      cycle: registry.selection.cycle,
      outcome,
      ...(options.summary ? { summary: options.summary } : {}),
    },
  );

  return markedScope
    ? { registry: nextRegistry, scope: markedScope, cycleCompleted }
    : { registry: nextRegistry, cycleCompleted };
};

export const readRalphScopeRegistryFile = async (
  path: string,
  options: {
    flowAlias: string;
    strategy: RalphScopeSelectionStrategy;
    now?: string;
  },
): Promise<RalphScopeRegistry> => {
  try {
    return parseRalphScopeRegistry(JSON.parse(await readFile(path, "utf8")), options);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return createDefaultRegistry(
        options.flowAlias,
        options.strategy,
        options.now ?? new Date().toISOString(),
      );
    }

    throw error;
  }
};

export const writeRalphScopeRegistryFile = async (
  path: string,
  registry: RalphScopeRegistry,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
};

export const formatRalphScopeRegistryMarkdown = (
  registry: RalphScopeRegistry,
): string => {
  const lines = [
    `# Ralph Scope Registry: ${registry.flowAlias}`,
    "",
    `Updated: ${registry.updatedAt}`,
    `Strategy: ${registry.selection.strategy}`,
    `Cycle: ${registry.selection.cycle}`,
    "",
    "## Active Scopes",
    "",
  ];
  const activeScopes = getActiveScopes(registry);

  if (activeScopes.length === 0) {
    lines.push("No active scopes discovered.", "");
  } else {
    for (const scope of activeScopes) {
      lines.push(
        `- ${scope.id}: ${scope.title} (${scope.kind}, risk=${scope.risk}, priority=${scope.priority})`,
        `  - paths: ${scope.paths.join(", ")}`,
        `  - selected: ${scope.selectedCount}, validated: ${scope.validatedCount}`,
      );
    }
    lines.push("");
  }

  const removedScopes = registry.scopes.filter((scope) => scope.status === "removed");
  if (removedScopes.length > 0) {
    lines.push("## Removed Scopes", "");
    for (const scope of removedScopes) {
      lines.push(`- ${scope.id}: ${scope.title}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
};
