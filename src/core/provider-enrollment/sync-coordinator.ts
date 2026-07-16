import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { discoverCustomizations } from "../customizations.js";
import { getUserConfigPath, loadWorkspaceEnv } from "../env.js";
import {
  getAgentCliProviders,
  resolveAgentCliProviderBinary,
} from "../_helpers/agent-cli-providers.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeFileAtomically, writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import type {
  AgentCliProvider,
} from "../runtime-contract.generated.js";
import type { DiscoveredInstruction } from "../types.js";
import { loadProviderEnrollmentConfig } from "./config.js";
import { PROVIDER_CAPABILITY_REGISTRY, probeProviderCli } from "./capability-registry.js";
import { compilePersistentInstructionBundle } from "./instruction-compiler.js";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import { projectMcpForProvider } from "./mcp-projector.js";
import { scanNativeInstructionSources } from "./native-source-scanner.js";
import {
  installManagedTarget,
  inspectManagedTarget,
  loadOwnershipManifest,
  saveOwnershipManifest,
  stripManagedProviderRegions,
  uninstallManagedTarget,
  type ManagedTargetFormat,
  type ProviderOwnershipManifest,
  type ProviderOwnershipRecord,
} from "./ownership-merge.js";
import { renderCodexMcpToml } from "./toml.js";
import {
  isProviderSyncAutostartInstalled,
  getProviderSyncAutostartPath,
} from "./platform-autostart.js";
import {
  PROVIDER_ENROLLMENT_SCHEMA_VERSION,
  type EnrollmentCoverageEntry,
  type ProviderSyncStatus,
  type ProviderSyncTargetStatus,
} from "./types.js";
import { sha256 } from "./digests.js";

const STATE_DIRECTORY_NAME = "provider-enrollment";
const OWNERSHIP_FILE_NAME = "ownership.json";
const STATUS_FILE_NAME = "sync-status.json";
const COVERAGE_FILE_NAME = "coverage-ledger.json";
const WORKSPACE_REGISTRY_FILE_NAME = "workspace-roots.json";
const RECONCILE_LOCK_FILE_NAME = "reconcile.state";

interface ProviderTargetPaths {
  instructionPath: string;
  mcpPath: string;
  mcpFormat: Extract<ManagedTargetFormat, "toml" | "json">;
}

interface ReconcileOutput {
  status: ProviderSyncStatus;
  ownership: ProviderOwnershipManifest;
  coverage: EnrollmentCoverageEntry[];
}

export const getProviderEnrollmentStateDirectory = (): string => {
  return join(dirname(getUserConfigPath()), STATE_DIRECTORY_NAME);
};

export const getProviderSyncOwnershipPath = (): string => {
  return join(getProviderEnrollmentStateDirectory(), OWNERSHIP_FILE_NAME);
};

const getWorkspaceStateSuffix = (workspaceRoot: string): string => {
  const normalized = resolve(workspaceRoot).replaceAll("\\", "/");
  return sha256(process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized)
    .slice(0, 16);
};

export const getProviderSyncStatusPath = (workspaceRoot: string): string => {
  return join(
    getProviderEnrollmentStateDirectory(),
    STATUS_FILE_NAME.replace(".json", `-${getWorkspaceStateSuffix(workspaceRoot)}.json`),
  );
};

export const getProviderCoverageLedgerPath = (workspaceRoot: string): string => {
  return join(
    getProviderEnrollmentStateDirectory(),
    COVERAGE_FILE_NAME.replace(".json", `-${getWorkspaceStateSuffix(workspaceRoot)}.json`),
  );
};

export const getProviderSyncWorkspaceRegistryPath = (): string =>
  join(getProviderEnrollmentStateDirectory(), WORKSPACE_REGISTRY_FILE_NAME);

const deduplicateWorkspaceRoots = (roots: readonly string[]): string[] => {
  const unique = new Map<string, string>();
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    const key = process.platform === "win32"
      ? resolvedRoot.toLocaleLowerCase()
      : resolvedRoot;
    if (!unique.has(key)) unique.set(key, resolvedRoot);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
};

export const loadRegisteredProviderSyncWorkspaces = async (
  fallbackWorkspaceRoot?: string,
): Promise<string[]> => {
  const fallback = fallbackWorkspaceRoot ? [resolve(fallbackWorkspaceRoot)] : [];
  try {
    const value = JSON.parse(
      await readFile(getProviderSyncWorkspaceRegistryPath(), "utf8"),
    ) as { workspaceRoots?: unknown };
    const roots = Array.isArray(value.workspaceRoots)
      ? value.workspaceRoots.filter((root): root is string => typeof root === "string")
      : [];
    return deduplicateWorkspaceRoots([...roots, ...fallback])
      .filter((root) => existsSync(root))
  } catch {
    return fallback.filter((root) => existsSync(root));
  }
};

const registerProviderSyncWorkspace = async (workspaceRoot: string): Promise<void> => {
  const path = getProviderSyncWorkspaceRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await withCooperativeFileLock(path, async () => {
    const existingRoots = await loadRegisteredProviderSyncWorkspaces();
    const roots = deduplicateWorkspaceRoots([...existingRoots, workspaceRoot])
      .filter((root) => existsSync(root))
    if (
      roots.length === existingRoots.length &&
      roots.every((root, index) => root === existingRoots[index])
    ) {
      return;
    }
    await writeJsonAtomically(path, { schemaVersion: 1, workspaceRoots: roots });
  });
};

const resolveProviderHome = (provider: AgentCliProvider): string => {
  switch (provider) {
    case "codex-cli":
      return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    case "claude-cli":
      return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    case "copilot-cli":
      return process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
  }
};

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
            instructionPath: join(home, "AGENTS.md"),
            mcpPath: join(home, "config.toml"),
            mcpFormat: "toml",
          }
        : {
            instructionPath: join(workspaceRoot, "AGENTS.md"),
            mcpPath: join(workspaceRoot, ".codex", "config.toml"),
            mcpFormat: "toml",
          };
    case "claude-cli":
      return scope === "user"
        ? {
            instructionPath: join(home, "CLAUDE.md"),
            mcpPath: join(homedir(), ".claude.json"),
            mcpFormat: "json",
          }
        : {
            instructionPath: join(workspaceRoot, "CLAUDE.md"),
            mcpPath: join(workspaceRoot, ".mcp.json"),
            mcpFormat: "json",
          };
    case "copilot-cli":
      return scope === "user"
        ? {
            instructionPath: join(home, "copilot-instructions.md"),
            mcpPath: join(home, "mcp-config.json"),
            mcpFormat: "json",
          }
        : {
            instructionPath: join(workspaceRoot, ".github", "copilot-instructions.md"),
            mcpPath: join(workspaceRoot, ".github", "mcp.json"),
            mcpFormat: "json",
          };
  }
};

const isOwnNativeInstruction = (
  provider: AgentCliProvider,
  instruction: DiscoveredInstruction,
): boolean => {
  const path = instruction.path.replaceAll("\\", "/").toLowerCase();
  if (provider === "codex-cli") {
    return path === "agents.md" || path === "agents.override.md";
  }
  if (provider === "copilot-cli") {
    return path === "agents.md" ||
      path === ".github/copilot-instructions.md" ||
      path.startsWith(".github/instructions/");
  }
  return path === "claude.md" ||
    path === "claude.local.md" ||
    path.startsWith(".claude/rules/");
};

const prepareInstructions = (
  provider: AgentCliProvider,
  instructions: readonly DiscoveredInstruction[],
): DiscoveredInstruction[] => {
  return instructions
    .filter((instruction) => !isOwnNativeInstruction(provider, instruction))
    .map((instruction) => ({
      ...instruction,
      body: stripManagedProviderRegions(instruction.body),
    }))
    .filter((instruction) => instruction.body.trim().length > 0);
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
): Promise<void> => {
  const excludePath = join(workspaceRoot, ".git", "info", "exclude");
  if (!existsSync(join(workspaceRoot, ".git"))) return;
  const workspacePath = relative(workspaceRoot, targetPath).replaceAll("\\", "/");
  if (!workspacePath || workspacePath.startsWith("../")) return;
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  const marker = `/${workspacePath}`;
  if (existing.split(/\r?\n/u).includes(marker)) return;
  await writeFileAtomically(
    excludePath,
    `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${marker}\n`,
  );
};

const createCoverageEntries = (
  provider: AgentCliProvider,
  scope: "user" | "workspace",
  bundle: ReturnType<typeof compilePersistentInstructionBundle>,
  projection: Awaited<ReturnType<typeof projectMcpForProvider>>,
): EnrollmentCoverageEntry[] => {
  const refreshState = "awaiting-provider-refresh" as const;
  const degradedSourceIds = new Set(bundle.degradedSourceIds);
  return [
    ...bundle.sources.flatMap((source): EnrollmentCoverageEntry[] => source.sourceIds.map((sourceId) => ({
      entityId: `${scope}:${sourceId}`,
      entityKind: "instruction",
      provider,
      digest: source.bodyHash,
      route: degradedSourceIds.has(source.id) ? "uncovered" : "provider-native-adopted",
      fidelity: degradedSourceIds.has(source.id) ? "degraded" : "baseline",
      refreshState: degradedSourceIds.has(source.id) ? "degraded" : refreshState,
      covered: !degradedSourceIds.has(source.id),
      evidence: [{ kind: "file-hash", detail: `${scope} provider-native managed region`, digest: bundle.digest }],
      ...(degradedSourceIds.has(source.id)
        ? { warning: "Instruction content was truncated by the enrollment budget." }
        : {}),
    }))),
    ...bundle.omittedSources.flatMap((source): EnrollmentCoverageEntry[] => source.sourceIds.map((sourceId) => ({
      entityId: `${scope}:${sourceId}`,
      entityKind: "instruction",
      provider,
      digest: source.bodyHash,
      route: "uncovered",
      fidelity: "degraded",
      refreshState: "degraded",
      covered: false,
      evidence: [{ kind: "fallback", detail: "Instruction omitted by enrollment budget." }],
      warning: "Instruction was omitted by the enrollment budget.",
    }))),
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
        evidence: [{ kind: "file-hash", detail: `${scope} persistent MCP projection`, digest: projection.catalogDigest }],
        ...(server.warnings.length > 0 ? { warning: server.warnings.join(" ") } : {}),
      };
      const capabilityEntries = server.capabilities
        .filter((capability) => capability !== "unknown-until-connect")
        .map((capability): EnrollmentCoverageEntry => ({
          entityId: `${scope}:mcp-${capability}:${server.canonicalId}`,
          entityKind:
            capability === "tools" ? "mcp-tools"
              : capability === "resources" ? "mcp-resources"
                : capability === "prompts" ? "mcp-prompts"
                  : capability === "tasks" ? "mcp-tasks"
                    : "mcp-initialization-instructions",
          provider,
          digest: server.digest,
          route: server.route,
          fidelity: "baseline",
          refreshState,
          covered: true,
          capabilities: [capability],
          evidence: [{ kind: "file-hash", detail: `${scope} persistent MCP capability projection`, digest: projection.catalogDigest }],
        }));
      return [serverEntry, ...capabilityEntries];
    }),
  ];
};

const findPrevious = (
  manifest: ProviderOwnershipManifest,
  path: string,
): ProviderOwnershipRecord | undefined => manifest.targets.find((target) => target.path === path);

const reconcileProviderScope = async (
  provider: AgentCliProvider,
  scope: "user" | "workspace",
  workspaceRoot: string,
  instructions: readonly DiscoveredInstruction[],
  ownership: ProviderOwnershipManifest,
): Promise<{
  status: ProviderSyncTargetStatus;
  records: ProviderOwnershipRecord[];
  coverage: EnrollmentCoverageEntry[];
}> => {
  const paths = getProviderTargetPaths(provider, scope, workspaceRoot);
  const warnings: string[] = [];
  try {
    const bundle = compilePersistentInstructionBundle(
      prepareInstructions(provider, instructions),
      "executor",
      { scope },
    );
    const projection = await projectMcpForProvider(provider, workspaceRoot, {
      persistent: true,
      scope,
    });
    const previousInstruction = findPrevious(ownership, paths.instructionPath);
    const previousMcp = findPrevious(ownership, paths.mcpPath);
    const instructionInstall = await installManagedTarget({
      path: paths.instructionPath,
      provider,
      scope,
      format: "markdown",
      payload: [
        `# Machdoch managed instructions (${scope})`,
        `Canonical bundle digest: ${bundle.digest}`,
        "",
        bundle.renderedText || "No Machdoch-managed instructions are configured for this scope.",
      ].join("\n"),
      ...(previousInstruction ? { previous: previousInstruction } : {}),
    });
    const mcpInstall = await installManagedTarget({
      path: paths.mcpPath,
      provider,
      scope,
      format: paths.mcpFormat,
      payload: getMcpPayload(paths.mcpFormat, projection.config),
      ...(previousMcp ? { previous: previousMcp } : {}),
    });
    warnings.push(
      ...instructionInstall.warnings,
      ...mcpInstall.warnings,
      ...bundle.warnings,
      ...projection.warnings,
    );
    if (scope === "workspace") {
      if (instructionInstall.record.createdFile) {
        await addWorkspaceGitExclude(workspaceRoot, paths.instructionPath);
      }
      if (mcpInstall.record.createdFile) {
        await addWorkspaceGitExclude(workspaceRoot, paths.mcpPath);
      }
    }
    const coverage = createCoverageEntries(provider, scope, bundle, projection);
    const coverageSummary = summarizeEnrollmentCoverage(coverage);
    return {
      status: {
        provider,
        scope,
        state: coverageSummary.complete ? "awaiting-provider-refresh" : "degraded",
        targetPaths: [paths.instructionPath, paths.mcpPath],
        bundleDigest: bundle.digest,
        updatedAt: new Date().toISOString(),
        warnings,
      },
      records: [instructionInstall.record, mcpInstall.record],
      coverage,
    };
  } catch (error) {
    return {
      status: {
        provider,
        scope,
        state: "degraded",
        targetPaths: [paths.instructionPath, paths.mcpPath],
        updatedAt: new Date().toISOString(),
        warnings,
        error: error instanceof Error ? error.message : String(error),
      },
      records: [],
      coverage: [],
    };
  }
};

const buildDaemonStatus = async (): Promise<ProviderSyncStatus["daemon"]> => {
  const { getProviderSyncDaemonPid } = await import("./sync-daemon.js");
  const pid = await getProviderSyncDaemonPid();
  const autostartInstalled = await isProviderSyncAutostartInstalled();
  return {
    running: pid !== undefined,
    ...(pid ? { pid } : {}),
    autostartInstalled,
    ...(autostartInstalled ? { autostartPath: getProviderSyncAutostartPath() } : {}),
  };
};

const reconcileOnce = async (workspaceRoot: string): Promise<ReconcileOutput> => {
  const config = await loadProviderEnrollmentConfig();
  const ownership = await loadOwnershipManifest(getProviderSyncOwnershipPath());
  const daemon = await buildDaemonStatus();
  if (!config.enabled || !config.persistentSync.enabled) {
    return {
      status: {
        schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
        enabled: false,
        daemon,
        workspaceRoot,
        targets: [],
      },
      ownership,
      coverage: [],
    };
  }

  const [customizations, env] = await Promise.all([
    discoverCustomizations(workspaceRoot, {
      discoverGithubCustomizations: true,
      discoverUserCustomizations: true,
      includeDiagnostics: true,
    }),
    loadWorkspaceEnv(workspaceRoot),
  ]);
  const statuses: ProviderSyncTargetStatus[] = [];
  const records: ProviderOwnershipRecord[] = [];
  const coverage: EnrollmentCoverageEntry[] = [];

  for (const provider of getAgentCliProviders()) {
    if (!config.providers[provider].enabled) continue;
    const binary = resolveAgentCliProviderBinary(provider, env);
    if (!binary.available) {
      for (const scope of ["user", "workspace"] as const) {
        const paths = getProviderTargetPaths(provider, scope, workspaceRoot);
        statuses.push({
          provider,
          scope,
          state: "not-installed",
          targetPaths: [paths.instructionPath, paths.mcpPath],
          updatedAt: new Date().toISOString(),
          warnings: [binary.reason ?? `${provider} is not installed.`],
        });
      }
      continue;
    }

    for (const scope of ["user", "workspace"] as const) {
      const result = await reconcileProviderScope(
        provider,
        scope,
        workspaceRoot,
        customizations.instructions,
        ownership,
      );
      statuses.push(result.status);
      records.push(...result.records);
      coverage.push(...result.coverage);
    }
  }

  const retainedRecords = ownership.targets.filter(
    (record) => !records.some((next) => next.path === record.path),
  );
  const nextOwnership: ProviderOwnershipManifest = {
    schemaVersion: 1,
    targets: [...retainedRecords, ...records].sort((left, right) => left.path.localeCompare(right.path)),
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
  const lockTarget = join(stateDirectory, RECONCILE_LOCK_FILE_NAME);
  return await withCooperativeFileLock(lockTarget, async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const output = await reconcileOnce(workspaceRoot);
        await saveOwnershipManifest(getProviderSyncOwnershipPath(), output.ownership);
        await writeJsonAtomically(getProviderCoverageLedgerPath(workspaceRoot), {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          entries: output.coverage,
        });
        await writeJsonAtomically(getProviderSyncStatusPath(workspaceRoot), output.status);
        return output.status;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          const delay = 100 * 2 ** attempt + Math.floor(Math.random() * 100);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  });
};

export const loadProviderSyncStatus = async (
  workspaceRoot: string,
): Promise<ProviderSyncStatus> => {
  try {
    const status = JSON.parse(
      await readFile(getProviderSyncStatusPath(workspaceRoot), "utf8"),
    ) as ProviderSyncStatus;
    return {
      ...status,
      daemon: await buildDaemonStatus(),
    };
  } catch {
    const config = await loadProviderEnrollmentConfig();
    return {
      schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
      enabled: config.enabled && config.persistentSync.enabled,
      daemon: await buildDaemonStatus(),
      workspaceRoot,
      targets: [],
    };
  }
};

export const uninstallProviderSyncTargets = async (): Promise<string[]> => {
  const manifest = await loadOwnershipManifest(getProviderSyncOwnershipPath());
  const warnings: string[] = [];
  const retained: ProviderOwnershipRecord[] = [];
  for (const record of manifest.targets) {
    const result = await uninstallManagedTarget(record);
    if (result.warning) warnings.push(result.warning);
    if (!result.removed) retained.push(record);
  }
  await saveOwnershipManifest(getProviderSyncOwnershipPath(), {
    schemaVersion: 1,
    targets: retained,
  });
  return warnings;
};

export const createProviderSyncPlan = async (
  workspaceRoot: string,
  onlyProvider?: AgentCliProvider,
): Promise<Record<string, unknown>> => {
  const [config, customizations, env, status] = await Promise.all([
    loadProviderEnrollmentConfig(),
    discoverCustomizations(workspaceRoot, {
      discoverGithubCustomizations: true,
      discoverUserCustomizations: true,
      includeDiagnostics: true,
    }),
    loadWorkspaceEnv(workspaceRoot),
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
      const bundle = compilePersistentInstructionBundle(
        prepareInstructions(provider, customizations.instructions),
        "executor",
        { scope },
      );
      const projection = await projectMcpForProvider(provider, workspaceRoot, {
        persistent: true,
        scope,
      });
      const coverage = createCoverageEntries(provider, scope, bundle, projection);
      const nativeInstructionFindings = scope === "workspace"
        ? await scanNativeInstructionSources(provider, workspaceRoot, bundle)
        : [];
      scopes.push({
        scope,
        instructionTarget: paths.instructionPath,
        mcpTarget: paths.mcpPath,
        bundleDigest: bundle.digest,
        instructionCount: [...bundle.sources, ...bundle.omittedSources]
          .reduce((count, source) => count + source.sourceIds.length, 0),
        instructionEntities: [
          ...bundle.sources.flatMap((source) => source.sourceIds.map((id) => ({
            id,
            route: bundle.degradedSourceIds.includes(source.id)
              ? "uncovered"
              : "provider-native-adopted",
            fallbackChain: ["provider-native-adopted", "cli-prompt-fallback", "uncovered"],
          }))),
          ...bundle.omittedSources.flatMap((source) => source.sourceIds.map((id) => ({
            id,
            route: "uncovered",
            fallbackChain: ["provider-native-adopted", "cli-prompt-fallback", "uncovered"],
          }))),
        ],
        nativeInstructionFindings,
        estimatedTokens: bundle.estimatedTokens,
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
        coverage: summarizeEnrollmentCoverage(coverage),
        warnings: [...bundle.warnings, ...projection.warnings],
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
    unmanagedInstructionPolicy: config.instructions.unmanagedNative,
    unmanagedMcpPolicy: config.mcp.unmanagedNative,
    approvals: config.mcp.approvals,
    providers,
    currentStatus: status,
    diagnostics: customizations.diagnostics ?? [],
  };
};

export const doctorProviderSync = async (
  workspaceRoot: string,
): Promise<Record<string, unknown>> => {
  const [plan, status, ownership, coverageRaw, env] = await Promise.all([
    createProviderSyncPlan(workspaceRoot),
    loadProviderSyncStatus(workspaceRoot),
    loadOwnershipManifest(getProviderSyncOwnershipPath()),
    readFile(getProviderCoverageLedgerPath(workspaceRoot), "utf8").catch(() => ""),
    loadWorkspaceEnv(workspaceRoot),
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
  const targetChecks = await Promise.all(ownership.targets.map(async (target) => ({
    path: target.path,
    provider: target.provider,
    scope: target.scope,
    ...(await inspectManagedTarget(target)),
  })));
  const missingTargets = targetChecks.filter((target) => !target.exists);
  const driftedTargets = targetChecks.filter(
    (target) => target.exists && (!target.syntaxValid || !target.managedCurrent),
  );
  return {
    healthy:
      status.targets.every((target) => target.state !== "degraded") &&
      uncovered.length === 0 &&
      missingTargets.length === 0 &&
      driftedTargets.length === 0,
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
    plan,
  };
};
