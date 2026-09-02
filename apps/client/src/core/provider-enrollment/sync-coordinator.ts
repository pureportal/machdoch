import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  getAgentCliProviders,
  resolveAgentCliProviderBinary,
} from "../_helpers/agent-cli-providers.js";
import {
  inspectCooperativeFileLock,
  withCooperativeFileLock,
} from "../_helpers/with-cooperative-file-lock.helper.js";
import {
  writeFileAtomically,
  writeJsonAtomically,
} from "../_helpers/write-file-atomically.helper.js";
import { getUserConfigPath, loadRuntimeEnvironment } from "../env.js";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import {
  PROVIDER_CAPABILITY_REGISTRY,
  probeProviderCli,
} from "./capability-registry.js";
import { loadProviderEnrollmentConfig } from "./config.js";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import { compareCanonicalStrings, sha256 } from "./digests.js";
import { projectMcpForProvider } from "./mcp-projector.js";
import {
  assertStableManagedTargetUnchanged,
  getManagedTargetPathIdentity,
  inspectManagedTarget,
  installManagedTarget,
  loadOwnershipManifest,
  loadOwnershipManifestSnapshot,
  readStableManagedTarget,
  saveOwnershipManifest,
  uninstallManagedTarget,
  type ManagedTargetFormat,
  type ProviderOwnershipManifest,
  type ProviderOwnershipRecord,
  type StableManagedTargetSnapshot,
} from "./ownership-merge.js";
import {
  getProviderSyncAutostartPath,
  isProviderSyncAutostartInstalled,
} from "./platform-autostart.js";
import { renderCodexMcpToml } from "./toml.js";
import {
  PROVIDER_ENROLLMENT_SCHEMA_VERSION,
  type EnrollmentCoverageEntry,
  type ProviderSyncStatus,
  type ProviderSyncTargetStatus,
} from "./types.js";

const STATE_DIRECTORY_NAME = "provider-enrollment";
const OWNERSHIP_FILE_NAME = "ownership.json";
const STATUS_FILE_NAME = "sync-status.json";
const COVERAGE_FILE_NAME = "coverage-ledger.json";
const WORKSPACE_REGISTRY_FILE_NAME = "workspace-roots.json";
const RECONCILE_LOCK_FILE_NAME = "reconcile.state";
const RECONCILE_LOCK_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

const getReconcileLockTarget = (): string =>
  join(getProviderEnrollmentStateDirectory(), RECONCILE_LOCK_FILE_NAME);

interface ProviderTargetPaths {
  mcpPath: string;
  mcpFormat: Extract<ManagedTargetFormat, "toml" | "json">;
}

interface ReconcileOutput {
  status: ProviderSyncStatus;
  ownership: ProviderOwnershipManifest;
  ownershipTargetSnapshot: StableManagedTargetSnapshot | undefined;
  coverage: EnrollmentCoverageEntry[];
}

export const getProviderEnrollmentStateDirectory = (): string => {
  return join(dirname(getUserConfigPath()), STATE_DIRECTORY_NAME);
};

export const getProviderSyncOwnershipPath = (): string => {
  return join(getProviderEnrollmentStateDirectory(), OWNERSHIP_FILE_NAME);
};

const normalizeWorkspaceRootIdentity = (workspaceRoot: string): string => {
  const resolvedRoot = resolve(workspaceRoot);
  if (process.platform !== "win32") return resolvedRoot;
  if (resolvedRoot.startsWith("\\\\?\\")) return resolvedRoot;
  if (resolvedRoot.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${resolvedRoot.slice(2)}`;
  }
  return `\\\\?\\${resolvedRoot}`;
};

const getWorkspaceRootIdentityKey = (workspaceRoot: string): string => {
  const normalized = normalizeWorkspaceRootIdentity(workspaceRoot);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
};

const getWorkspaceStateSuffix = (workspaceRoot: string): string => {
  return sha256(
    getWorkspaceRootIdentityKey(workspaceRoot).replaceAll("\\", "/"),
  ).slice(0, 16);
};

export const getProviderSyncStatusPath = (workspaceRoot: string): string => {
  return join(
    getProviderEnrollmentStateDirectory(),
    STATUS_FILE_NAME.replace(
      ".json",
      `-${getWorkspaceStateSuffix(workspaceRoot)}.json`,
    ),
  );
};

export const getProviderCoverageLedgerPath = (
  workspaceRoot: string,
): string => {
  return join(
    getProviderEnrollmentStateDirectory(),
    COVERAGE_FILE_NAME.replace(
      ".json",
      `-${getWorkspaceStateSuffix(workspaceRoot)}.json`,
    ),
  );
};

export const getProviderSyncWorkspaceRegistryPath = (): string =>
  join(getProviderEnrollmentStateDirectory(), WORKSPACE_REGISTRY_FILE_NAME);

const deduplicateWorkspaceRoots = (roots: readonly string[]): string[] => {
  const unique = new Map<string, string>();
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    const key = getWorkspaceRootIdentityKey(resolvedRoot);
    if (!unique.has(key)) unique.set(key, resolvedRoot);
  }
  return [...unique.values()].sort(compareCanonicalStrings);
};

const parseStoredProviderSyncWorkspaceRoots = (
  path: string,
  snapshot: StableManagedTargetSnapshot | undefined,
): string[] => {
  if (!snapshot) return [];
  const value = JSON.parse(snapshot.content) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("workspaceRoots" in value) ||
    !Array.isArray(value.workspaceRoots) ||
    value.workspaceRoots.length > 4_096 ||
    !value.workspaceRoots.every(
      (root) =>
        typeof root === "string" &&
        root.length > 0 &&
        root.length <= 32_768 &&
        resolve(root) === root,
    )
  ) {
    throw new Error(`${path} is not a valid provider-sync workspace registry.`);
  }
  return value.workspaceRoots;
};

const loadStoredProviderSyncWorkspaceRoots = async (): Promise<string[]> => {
  const path = getProviderSyncWorkspaceRegistryPath();
  return parseStoredProviderSyncWorkspaceRoots(
    path,
    await readStableManagedTarget(path),
  );
};

export const loadRegisteredProviderSyncWorkspaces = async (
  fallbackWorkspaceRoot?: string,
): Promise<string[]> => {
  const fallback = fallbackWorkspaceRoot
    ? [resolve(fallbackWorkspaceRoot)]
    : [];
  const roots = await loadStoredProviderSyncWorkspaceRoots();
  return deduplicateWorkspaceRoots([...roots, ...fallback]).filter((root) =>
    existsSync(root),
  );
};

export const registerProviderSyncWorkspace = async (
  workspaceRoot: string,
): Promise<void> => {
  const path = getProviderSyncWorkspaceRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await withCooperativeFileLock(
    path,
    async () => {
      const before = await readStableManagedTarget(path);
      const storedRoots = parseStoredProviderSyncWorkspaceRoots(path, before);
      const roots = deduplicateWorkspaceRoots([...storedRoots, workspaceRoot]);
      if (
        roots.length === storedRoots.length &&
        roots.every((root, index) => root === storedRoots[index])
      ) {
        return;
      }
      await writeJsonAtomically(
        path,
        {
          schemaVersion: 1,
          workspaceRoots: roots,
        },
        {
          beforeCommit: async () =>
            assertStableManagedTargetUnchanged(path, before),
        },
      );
    },
    {
      ownerDescription: "provider-sync workspace registry update",
    },
  );
};

const resolveProviderHome = (provider: AgentCliProvider): string => {
  switch (provider) {
    case "codex-cli":
      return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    case "claude-cli":
      return (
        process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude")
      );
    case "copilot-cli":
      return process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
  }
};

export const getProviderSyncTargetDiscoveryIdentity = (): {
  userHome: string;
  codexHome: string;
  claudeConfigDirectory: string;
  copilotHome: string;
} => ({
  userHome: homedir(),
  codexHome: resolveProviderHome("codex-cli"),
  claudeConfigDirectory: resolveProviderHome("claude-cli"),
  copilotHome: resolveProviderHome("copilot-cli"),
});

const getProviderTargetPaths = (
  provider: AgentCliProvider,
  scope: "user" | "workspace",
  workspaceRoot: string,
): ProviderTargetPaths => {
  const home = resolveProviderHome(provider);
  switch (provider) {
    case "codex-cli":
      return scope === "user"
        ? {
            mcpPath: join(home, "config.toml"),
            mcpFormat: "toml",
          }
        : {
            mcpPath: join(workspaceRoot, ".codex", "config.toml"),
            mcpFormat: "toml",
          };
    case "claude-cli":
      return scope === "user"
        ? {
            mcpPath: join(homedir(), ".claude.json"),
            mcpFormat: "json",
          }
        : {
            mcpPath: join(workspaceRoot, ".mcp.json"),
            mcpFormat: "json",
          };
    case "copilot-cli":
      return scope === "user"
        ? {
            mcpPath: join(home, "mcp-config.json"),
            mcpFormat: "json",
          }
        : {
            mcpPath: join(workspaceRoot, ".github", "mcp.json"),
            mcpFormat: "json",
          };
  }
};

const getMcpPayload = (
  format: ProviderTargetPaths["mcpFormat"],
  config: Record<string, unknown>,
): string | Record<string, unknown> => {
  if (format === "json") return config;
  const servers =
    typeof config.mcpServers === "object" &&
    config.mcpServers !== null &&
    !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  return renderCodexMcpToml(servers);
};

const addWorkspaceGitExclude = async (
  workspaceRoot: string,
  targetPath: string,
): Promise<string | undefined> => {
  if (!existsSync(join(workspaceRoot, ".git"))) return undefined;
  const workspacePath = relative(workspaceRoot, targetPath).replaceAll(
    "\\",
    "/",
  );
  if (!workspacePath || workspacePath.startsWith("../")) return undefined;

  let excludePath: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "rev-parse", "--git-path", "info/exclude"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const reportedPath = stdout.trim();
    if (
      !reportedPath ||
      reportedPath.includes("\0") ||
      reportedPath.includes("\n") ||
      reportedPath.length > 32_768
    ) {
      throw new Error("Git returned an invalid exclude path.");
    }
    excludePath = resolve(workspaceRoot, reportedPath);
  } catch (error) {
    return `Could not resolve the Git exclude file for ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    await withCooperativeFileLock(
      excludePath,
      async () => {
        const before = await readStableManagedTarget(excludePath);
        const existing = before?.content ?? "";
        const marker = `/${workspacePath}`;
        if (existing.split(/\r?\n/u).includes(marker)) return;
        await writeFileAtomically(
          excludePath,
          `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${marker}\n`,
          "utf8",
          {
            beforeCommit: async () =>
              assertStableManagedTargetUnchanged(excludePath, before),
          },
        );
      },
      { ownerDescription: `provider-sync Git exclusion for ${workspaceRoot}` },
    );
  } catch (error) {
    return `Could not add ${workspacePath} to ${excludePath}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
};

const createCoverageEntries = (
  provider: AgentCliProvider,
  scope: "user" | "workspace",
  projection: Awaited<ReturnType<typeof projectMcpForProvider>>,
): EnrollmentCoverageEntry[] => {
  const refreshState = "awaiting-provider-refresh" as const;
  return [
    ...projection.servers.flatMap((server): EnrollmentCoverageEntry[] => {
      const serverEntry: EnrollmentCoverageEntry = {
        entityId: `${scope}:mcp-server:${server.canonicalId}`,
        entityKind: "mcp-server",
        provider,
        digest: server.digest,
        route: server.route,
        fidelity: "baseline",
        refreshState,
        covered: true,
        capabilities: server.capabilities,
        evidence: [
          {
            kind: "file-hash",
            detail: `${scope} persistent MCP projection`,
            digest: projection.catalogDigest,
          },
        ],
        ...(server.warnings.length > 0
          ? { warning: server.warnings.join(" ") }
          : {}),
      };
      const capabilityEntries = server.capabilities
        .filter((capability) => capability !== "unknown-until-connect")
        .map(
          (capability): EnrollmentCoverageEntry => ({
            entityId: `${scope}:mcp-${capability}:${server.canonicalId}`,
            entityKind:
              capability === "tools"
                ? "mcp-tools"
                : capability === "resources"
                  ? "mcp-resources"
                  : capability === "prompts"
                    ? "mcp-prompts"
                    : capability === "tasks"
                      ? "mcp-tasks"
                      : "mcp-initialization-instructions",
            provider,
            digest: server.digest,
            route: server.route,
            fidelity: "baseline",
            refreshState,
            covered: true,
            capabilities: [capability],
            evidence: [
              {
                kind: "file-hash",
                detail: `${scope} persistent MCP capability projection`,
                digest: projection.catalogDigest,
              },
            ],
          }),
        );
      return [serverEntry, ...capabilityEntries];
    }),
    ...projection.uncoveredServers.map(
      (server): EnrollmentCoverageEntry => ({
        entityId: `${scope}:mcp-server:${server.canonicalId}`,
        entityKind: "mcp-server",
        provider,
        digest: server.digest,
        route: "uncovered",
        fidelity: "degraded",
        refreshState: "degraded",
        covered: false,
        capabilities: server.capabilities,
        evidence: [],
        warning: server.reason,
      }),
    ),
  ];
};

const findPrevious = (
  manifest: ProviderOwnershipManifest,
  path: string,
): ProviderOwnershipRecord | undefined => {
  const pathIdentity = getManagedTargetPathIdentity(path);
  const matches = manifest.targets.filter(
    (target) => getManagedTargetPathIdentity(target.path) === pathIdentity,
  );
  const selected = matches.sort(
    (left, right) =>
      Date.parse(right.installedAt) - Date.parse(left.installedAt) ||
      compareCanonicalStrings(left.path, right.path),
  )[0];
  return selected && matches.length > 1
    ? {
        ...selected,
        createdFile: matches.every((target) => target.createdFile),
      }
    : selected;
};

const reconcileProviderScope = async (
  provider: AgentCliProvider,
  scope: "user" | "workspace",
  workspaceRoot: string,
  ownership: ProviderOwnershipManifest,
  checkpointOwnership: (record: ProviderOwnershipRecord) => Promise<void>,
): Promise<{
  status: ProviderSyncTargetStatus;
  records: ProviderOwnershipRecord[];
  coverage: EnrollmentCoverageEntry[];
}> => {
  const paths = getProviderTargetPaths(provider, scope, workspaceRoot);
  const warnings: string[] = [];
  const previousMcp = findPrevious(ownership, paths.mcpPath);
  const recordsByPath = new Map(
    [previousMcp]
      .filter((record): record is ProviderOwnershipRecord => Boolean(record))
      .map((record) => [getManagedTargetPathIdentity(record.path), record]),
  );
  let ownershipCheckpointCommitted = false;
  try {
    const projection = await projectMcpForProvider(provider, workspaceRoot, {
      persistent: true,
      scope,
    });
    let mcpInstall:
      | Awaited<ReturnType<typeof installManagedTarget>>
      | undefined;
    if (projection.servers.length > 0) {
      mcpInstall = await installManagedTarget({
        path: previousMcp?.path ?? paths.mcpPath,
        provider,
        scope,
        format: paths.mcpFormat,
        payload: getMcpPayload(paths.mcpFormat, projection.config),
        ...(previousMcp ? { previous: previousMcp } : {}),
        beforeTargetCommit: async (record) => {
          await checkpointOwnership(record);
          ownershipCheckpointCommitted = true;
        },
      });
      recordsByPath.set(
        getManagedTargetPathIdentity(paths.mcpPath),
        mcpInstall.record,
      );
      warnings.push(...mcpInstall.warnings);
    } else if (previousMcp) {
      const removal = await uninstallManagedTarget(previousMcp, {
        force: true,
      });
      if (removal.warning) warnings.push(removal.warning);
      if (removal.removed) {
        recordsByPath.delete(getManagedTargetPathIdentity(paths.mcpPath));
      }
    }
    warnings.push(...projection.warnings);
    if (scope === "workspace") {
      if (mcpInstall?.record.createdFile) {
        const gitExcludeWarning = await addWorkspaceGitExclude(
          workspaceRoot,
          paths.mcpPath,
        );
        if (gitExcludeWarning) warnings.push(gitExcludeWarning);
      }
    }
    const coverage = createCoverageEntries(provider, scope, projection);
    const coverageSummary = summarizeEnrollmentCoverage(coverage);
    return {
      status: {
        provider,
        scope,
        state: coverageSummary.complete
          ? "awaiting-provider-refresh"
          : "degraded",
        targetPaths: [paths.mcpPath],
        updatedAt: new Date().toISOString(),
        warnings,
      },
      records: [...recordsByPath.values()],
      coverage,
    };
  } catch (error) {
    if (ownershipCheckpointCommitted) throw error;
    if (previousMcp) {
      try {
        const removal = await uninstallManagedTarget(previousMcp, {
          force: true,
        });
        if (removal.warning) warnings.push(removal.warning);
        if (removal.removed) {
          recordsByPath.delete(getManagedTargetPathIdentity(paths.mcpPath));
        }
      } catch (cleanupError) {
        warnings.push(
          `Failed to remove the previous generated MCP target after projection failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    return {
      status: {
        provider,
        scope,
        state: "degraded",
        targetPaths: [paths.mcpPath],
        updatedAt: new Date().toISOString(),
        warnings,
        error: error instanceof Error ? error.message : String(error),
      },
      records: [...recordsByPath.values()],
      coverage: [],
    };
  }
};

const uninstallOwnedRecords = async (
  records: readonly ProviderOwnershipRecord[],
): Promise<{
  retained: ProviderOwnershipRecord[];
  warnings: string[];
}> => {
  const retained: ProviderOwnershipRecord[] = [];
  const warnings: string[] = [];
  for (const record of records) {
    try {
      const result = await uninstallManagedTarget(record, { force: true });
      if (result.warning) warnings.push(result.warning);
      if (!result.removed) retained.push(record);
    } catch (error) {
      retained.push(record);
      warnings.push(
        `Failed to remove ${record.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { retained, warnings };
};

const buildDaemonStatus = async (): Promise<ProviderSyncStatus["daemon"]> => {
  const { getProviderSyncDaemonPid } = await import("./sync-daemon.js");
  const pid = await getProviderSyncDaemonPid();
  const autostartInstalled = await isProviderSyncAutostartInstalled();
  return {
    running: pid !== undefined,
    ...(pid ? { pid } : {}),
    autostartInstalled,
    ...(autostartInstalled
      ? { autostartPath: getProviderSyncAutostartPath() }
      : {}),
  };
};

const reconcileOnce = async (
  workspaceRoot: string,
): Promise<ReconcileOutput> => {
  const config = await loadProviderEnrollmentConfig();
  const ownershipPath = getProviderSyncOwnershipPath();
  const loadedOwnership = await loadOwnershipManifestSnapshot(ownershipPath);
  const ownership = loadedOwnership.manifest;
  let ownershipTargetSnapshot = loadedOwnership.targetSnapshot;
  let checkpointManifest = ownership;
  const checkpointOwnership = async (
    record: ProviderOwnershipRecord,
  ): Promise<void> => {
    const nextManifest: ProviderOwnershipManifest = {
      schemaVersion: 1,
      targets: [
        ...checkpointManifest.targets.filter(
          (candidate) =>
            getManagedTargetPathIdentity(candidate.path) !==
            getManagedTargetPathIdentity(record.path),
        ),
        record,
      ].sort((left, right) => compareCanonicalStrings(left.path, right.path)),
    };
    ownershipTargetSnapshot = await saveOwnershipManifest(
      ownershipPath,
      nextManifest,
      { expectedTargetSnapshot: ownershipTargetSnapshot },
    );
    checkpointManifest = nextManifest;
  };
  const daemon = await buildDaemonStatus();
  if (!config.enabled || !config.persistentSync.enabled) {
    const cleanup = await uninstallOwnedRecords(ownership.targets);
    if (cleanup.retained.length > 0) {
      throw new Error(cleanup.warnings.join(" "));
    }
    return {
      status: {
        schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
        enabled: false,
        daemon,
        workspaceRoot,
        targets: [],
      },
      ownership: {
        schemaVersion: 1,
        targets: cleanup.retained,
      },
      ownershipTargetSnapshot,
      coverage: [],
    };
  }

  const env = await loadRuntimeEnvironment();
  const statuses: ProviderSyncTargetStatus[] = [];
  const records: ProviderOwnershipRecord[] = [];
  const coverage: EnrollmentCoverageEntry[] = [];
  const managedPathIdentities = new Set<string>();
  const reconciledUserProviders = new Set<string>();
  const disabledUserProviders = new Set<string>();

  for (const provider of getAgentCliProviders()) {
    for (const scope of ["user", "workspace"] as const) {
      const paths = getProviderTargetPaths(provider, scope, workspaceRoot);
      managedPathIdentities.add(getManagedTargetPathIdentity(paths.mcpPath));
    }
    if (!config.providers[provider].enabled) {
      disabledUserProviders.add(provider);
      continue;
    }
    const binary = resolveAgentCliProviderBinary(provider, env);
    for (const scope of ["user", "workspace"] as const) {
      const paths = getProviderTargetPaths(provider, scope, workspaceRoot);
      const hasPreviousTarget = Boolean(findPrevious(ownership, paths.mcpPath));
      if (!binary.available && !hasPreviousTarget) {
        statuses.push({
          provider,
          scope,
          state: "not-installed",
          targetPaths: [paths.mcpPath],
          updatedAt: new Date().toISOString(),
          warnings: [binary.reason ?? `${provider} is not installed.`],
        });
        continue;
      }

      const result = await reconcileProviderScope(
        provider,
        scope,
        workspaceRoot,
        ownership,
        checkpointOwnership,
      );
      if (!binary.available && result.status.state !== "degraded") {
        result.status = {
          ...result.status,
          state: "not-installed",
          warnings: [
            binary.reason ?? `${provider} is not installed.`,
            ...result.status.warnings,
          ],
        };
      }
      if (scope === "user" && result.status.state !== "degraded") {
        reconciledUserProviders.add(provider);
      }
      statuses.push(result.status);
      records.push(...result.records);
      coverage.push(...result.coverage);
    }
  }

  const currentPathIdentities = new Set(
    records.map((record) => getManagedTargetPathIdentity(record.path)),
  );
  const isManagedByThisReconciliation = (
    record: ProviderOwnershipRecord,
  ): boolean =>
    managedPathIdentities.has(getManagedTargetPathIdentity(record.path)) ||
    (record.scope === "user" &&
      (reconciledUserProviders.has(record.provider) ||
        disabledUserProviders.has(record.provider)));
  const obsoleteRecords = ownership.targets.filter(
    (record) =>
      isManagedByThisReconciliation(record) &&
      !currentPathIdentities.has(getManagedTargetPathIdentity(record.path)),
  );
  const cleanup = await uninstallOwnedRecords(obsoleteRecords);
  if (cleanup.retained.length > 0) {
    throw new Error(cleanup.warnings.join(" "));
  }
  const retainedRecords = ownership.targets.filter(
    (record) => !isManagedByThisReconciliation(record),
  );
  const nextOwnership: ProviderOwnershipManifest = {
    schemaVersion: 1,
    targets: [...retainedRecords, ...cleanup.retained, ...records].sort(
      (left, right) => compareCanonicalStrings(left.path, right.path),
    ),
  };
  return {
    status: {
      schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
      enabled: true,
      daemon,
      workspaceRoot,
      lastReconciledAt: new Date().toISOString(),
      targets: statuses,
    },
    ownership: nextOwnership,
    ownershipTargetSnapshot,
    coverage,
  };
};

export const reconcileProviderSync = async (
  workspaceRoot: string,
): Promise<ProviderSyncStatus> => {
  workspaceRoot = resolve(workspaceRoot);
  const stateDirectory = getProviderEnrollmentStateDirectory();
  await mkdir(stateDirectory, { recursive: true });
  await registerProviderSyncWorkspace(workspaceRoot);
  return await withCooperativeFileLock(
    getReconcileLockTarget(),
    async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const output = await reconcileOnce(workspaceRoot);
          await saveOwnershipManifest(
            getProviderSyncOwnershipPath(),
            output.ownership,
            {
              expectedTargetSnapshot: output.ownershipTargetSnapshot,
            },
          );
          await writeJsonAtomically(
            getProviderCoverageLedgerPath(workspaceRoot),
            {
              schemaVersion: 1,
              updatedAt: new Date().toISOString(),
              entries: output.coverage,
            },
          );
          await writeJsonAtomically(
            getProviderSyncStatusPath(workspaceRoot),
            output.status,
          );
          return output.status;
        } catch (error) {
          lastError = error;
          if (attempt < 2) {
            const delay = 100 * 2 ** attempt + Math.floor(Math.random() * 100);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    },
    {
      timeoutMs: RECONCILE_LOCK_TIMEOUT_MS,
      ownerDescription: `provider-sync reconcile for ${workspaceRoot}`,
    },
  );
};

export const loadProviderSyncStatus = async (
  workspaceRoot: string,
): Promise<ProviderSyncStatus> => {
  const config = await loadProviderEnrollmentConfig();
  const enabled = config.enabled && config.persistentSync.enabled;
  try {
    const status = JSON.parse(
      await readFile(getProviderSyncStatusPath(workspaceRoot), "utf8"),
    ) as ProviderSyncStatus;
    return {
      ...status,
      enabled,
      daemon: await buildDaemonStatus(),
    };
  } catch {
    return {
      schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
      enabled,
      daemon: await buildDaemonStatus(),
      workspaceRoot,
      targets: [],
    };
  }
};

export const uninstallProviderSyncTargets = async (): Promise<string[]> => {
  const stateDirectory = getProviderEnrollmentStateDirectory();
  await mkdir(stateDirectory, { recursive: true });
  return await withCooperativeFileLock(
    getReconcileLockTarget(),
    async () => {
      const loadedManifest = await loadOwnershipManifestSnapshot(
        getProviderSyncOwnershipPath(),
      );
      const manifest = loadedManifest.manifest;
      const warnings: string[] = [];
      const retained: ProviderOwnershipRecord[] = [];
      for (const record of manifest.targets) {
        const result = await uninstallManagedTarget(record, { force: true });
        if (result.warning) warnings.push(result.warning);
        if (!result.removed) retained.push(record);
      }
      await saveOwnershipManifest(
        getProviderSyncOwnershipPath(),
        {
          schemaVersion: 1,
          targets: retained,
        },
        { expectedTargetSnapshot: loadedManifest.targetSnapshot },
      );
      return warnings;
    },
    {
      timeoutMs: RECONCILE_LOCK_TIMEOUT_MS,
      ownerDescription: "provider-sync uninstall",
    },
  );
};

export const createProviderSyncPlan = async (
  workspaceRoot: string,
  onlyProvider?: AgentCliProvider,
): Promise<Record<string, unknown>> => {
  const [config, env, status] = await Promise.all([
    loadProviderEnrollmentConfig(),
    loadRuntimeEnvironment(),
    loadProviderSyncStatus(workspaceRoot),
  ]);
  const providers: Record<string, unknown>[] = [];
  for (const provider of getAgentCliProviders()) {
    if (onlyProvider && provider !== onlyProvider) continue;
    const binary = resolveAgentCliProviderBinary(provider, env);
    const probe = binary.executable
      ? await probeProviderCli(provider, binary.executable)
      : undefined;
    const scopes: Record<string, unknown>[] = [];
    for (const scope of ["user", "workspace"] as const) {
      const paths = getProviderTargetPaths(provider, scope, workspaceRoot);
      const projection = await projectMcpForProvider(provider, workspaceRoot, {
        persistent: true,
        scope,
      });
      const coverage = createCoverageEntries(provider, scope, projection);
      scopes.push({
        scope,
        mcpTarget: paths.mcpPath,
        mcpCatalogDigest: projection.catalogDigest,
        mcpServers: projection.servers.map((server) => ({
          id: server.canonicalId,
          route: server.route,
          capabilities: server.capabilities,
          fallbackChain: [
            "cli-native-mcp",
            "cli-stdio-proxy",
            "cli-aggregate-broker",
            "uncovered",
          ],
        })),
        uncoveredMcpServers: projection.uncoveredServers.map((server) => ({
          id: server.canonicalId,
          capabilities: server.capabilities,
          reason: server.reason,
        })),
        coverage: summarizeEnrollmentCoverage(coverage),
        warnings: projection.warnings,
      });
    }
    providers.push({
      provider,
      enabled: config.providers[provider].enabled,
      installed: binary.available,
      executable: binary.executable ?? null,
      version: probe?.version ?? null,
      detectedFeatures: probe?.features ?? [],
      capabilityProfile: PROVIDER_CAPABILITY_REGISTRY[provider],
      scopes,
    });
  }
  return {
    enabled: config.enabled && config.persistentSync.enabled,
    workspaceRoot,
    unmanagedMcpPolicy: config.mcp.unmanagedNative,
    approvals: config.mcp.approvals,
    providers,
    currentStatus: status,
  };
};

export const doctorProviderSync = async (
  workspaceRoot: string,
): Promise<Record<string, unknown>> => {
  const lockTarget = join(
    getProviderEnrollmentStateDirectory(),
    RECONCILE_LOCK_FILE_NAME,
  );
  const { loadProviderSyncDaemonDiagnostic } = await import("./sync-daemon.js");
  const [
    plan,
    status,
    ownership,
    coverageRaw,
    env,
    reconcileLock,
    daemonDiagnostic,
  ] = await Promise.all([
    createProviderSyncPlan(workspaceRoot),
    loadProviderSyncStatus(workspaceRoot),
    loadOwnershipManifest(getProviderSyncOwnershipPath()),
    readFile(getProviderCoverageLedgerPath(workspaceRoot), "utf8").catch(
      () => "",
    ),
    loadRuntimeEnvironment(),
    inspectCooperativeFileLock(lockTarget),
    loadProviderSyncDaemonDiagnostic(),
  ]);
  const probes = await Promise.all(
    getAgentCliProviders().map(async (provider) => {
      const binary = resolveAgentCliProviderBinary(provider, env);
      return binary.executable
        ? await probeProviderCli(provider, binary.executable)
        : {
            provider,
            available: false,
            features: [],
            warnings: [binary.reason ?? `${provider} is not installed.`],
          };
    }),
  );
  const coverage = coverageRaw
    ? (JSON.parse(coverageRaw) as { entries?: EnrollmentCoverageEntry[] })
    : { entries: [] };
  const uncovered = (coverage.entries ?? []).filter((entry) => !entry.covered);
  const targetChecks = await Promise.all(
    ownership.targets.map(async (target) => ({
      path: target.path,
      provider: target.provider,
      scope: target.scope,
      ...(await inspectManagedTarget(target)),
    })),
  );
  const missingTargets = targetChecks.filter((target) => !target.exists);
  const driftedTargets = targetChecks.filter(
    (target) =>
      target.exists && (!target.syntaxValid || !target.managedCurrent),
  );
  const workspaceRootIdentity = getWorkspaceRootIdentityKey(workspaceRoot);
  const daemonWorkspaceResult = daemonDiagnostic?.workspaceResults.find(
    (result) =>
      getWorkspaceRootIdentityKey(result.workspaceRoot) ===
      workspaceRootIdentity,
  );
  return {
    healthy:
      status.targets.every((target) => target.state !== "degraded") &&
      uncovered.length === 0 &&
      missingTargets.length === 0 &&
      driftedTargets.length === 0 &&
      reconcileLock.state !== "orphaned" &&
      reconcileLock.state !== "stale" &&
      daemonDiagnostic?.error === undefined &&
      daemonWorkspaceResult?.outcome !== "error",
    status,
    probes,
    ownership: {
      path: getProviderSyncOwnershipPath(),
      targets: ownership.targets.length,
      missingTargets: missingTargets.map((target) => target.path),
      driftedTargets: driftedTargets.map((target) => target.path),
      checks: targetChecks,
    },
    coverage: {
      path: getProviderCoverageLedgerPath(workspaceRoot),
      total: coverage.entries?.length ?? 0,
      uncovered: uncovered.map((entry) => entry.entityId),
    },
    locks: {
      reconcile: reconcileLock,
    },
    daemonDiagnostic: daemonDiagnostic ?? null,
    plan,
  };
};
