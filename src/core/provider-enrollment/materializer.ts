import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { getUserConfigPath } from "../env.js";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import type {
  FrozenInstructionSet,
  InstructionDeliveryPlan,
} from "../instruction-system/types.js";
import { createInstructionDeliveryPlan } from "../instruction-system/delivery.js";
import { renderInstructionTransportPayload } from "../mcp/initialization-instructions.js";
import {
  writeFileAtomically,
  writeJsonAtomically,
} from "../_helpers/write-file-atomically.helper.js";
import { readStableRegularFile as readStableRegularFileBytes } from "../_helpers/read-stable-regular-file.helper.js";
import { probeProviderCli } from "./capability-registry.js";
import {
  canUseClaudeBareMode,
  createCliInstructionCapabilityFromProbe,
} from "./instruction-delivery-preflight.js";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import { compareCanonicalStrings, sha256 } from "./digests.js";
import { projectMcpForProvider } from "./mcp-projector.js";
import { quoteTomlKey, renderCodexMcpToml } from "./toml.js";
import {
  PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION,
  type EnrollmentCoverageEntry,
  type EnrollmentManifest,
  type MaterializedInstructionDelivery,
  type MaterializedCliEnrollment,
  type McpProjection,
} from "./types.js";

const SESSION_ROOT_PREFIX = "machdoch-instruction-run-";
const SESSION_MARKER_NAME = ".machdoch-instruction-session.json";
const SESSION_MARKER_SCHEMA_VERSION = 1;
const STALE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSION_MARKER_BYTES = 16 * 1024;
const MAX_PROVIDER_STATE_BYTES = 4 * 1024 * 1024;
const MAX_COPILOT_WORKSPACE_MCP_FILES = 256;
const MAX_COPILOT_WORKSPACE_MCP_SERVERS = 512;
const MAX_COPILOT_DISABLE_MCP_ARGUMENT_BYTES = 16 * 1024;
const hasInvalidCopilotMcpServerNameCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      character === "}"
    );
  });

interface MaterializeCliEnrollmentParams {
  provider: AgentCliProvider;
  executable: string;
  runId: string;
  workspaceRoot: string;
  resolution: FrozenInstructionSet;
  deliveryPlan: InstructionDeliveryPlan;
  runtimeSystemInstructions: string;
}

interface RenderedEnrollmentFiles {
  args: string[];
  env: NodeJS.ProcessEnv;
  route: MaterializedInstructionDelivery["transportRoute"];
  files: Array<{ path: string; digest: string; purpose: string }>;
}

const isContainedTemporarySession = async (path: string): Promise<boolean> => {
  const canonicalTmp = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const canonicalPath = await realpath(path).catch(() => resolve(path));
  const rel = relative(canonicalTmp, canonicalPath);
  return (
    basename(canonicalPath).startsWith(SESSION_ROOT_PREFIX) &&
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
};

const readStableRegularFile = async (
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer | undefined> =>
  readStableRegularFileBytes(path, {
    maxBytes,
    messages: {
      invalid: (targetPath, limit) =>
        `${label} must be a regular, unlinked file no larger than ${limit} bytes: ${targetPath}`,
      changedBeforeOpen: (targetPath) =>
        `${label} changed before it could be opened safely: ${targetPath}`,
      changedWhileReading: (targetPath) =>
        `${label} changed while it was being read: ${targetPath}`,
    },
  });

const decodeStrictUtf8 = (content: Uint8Array, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(content)
      .replace(/^\uFEFF/u, "");
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8.`, { cause: error });
  }
};

const hasValidSessionMarker = async (path: string): Promise<boolean> => {
  try {
    const rootMetadata = await lstat(path);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return false;
    }
    const content = await readStableRegularFile(
      join(path, SESSION_MARKER_NAME),
      MAX_SESSION_MARKER_BYTES,
      "Machdoch session marker",
    );
    if (content === undefined) return false;
    const parsed = JSON.parse(
      decodeStrictUtf8(content, "Machdoch session marker"),
    ) as Record<string, unknown>;
    return (
      parsed.schemaVersion === SESSION_MARKER_SCHEMA_VERSION &&
      parsed.kind === "machdoch-instruction-run" &&
      typeof parsed.runId === "string" &&
      parsed.rootPath === path
    );
  } catch {
    return false;
  }
};

const removeSessionRoot = async (path: string): Promise<void> => {
  if (
    !(await isContainedTemporarySession(path)) ||
    !(await hasValidSessionMarker(path))
  ) {
    return;
  }
  const before = await lstat(path).catch(() => undefined);
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !(await isContainedTemporarySession(path))
  ) {
    return;
  }
  await rm(path, { recursive: true, force: true });
};

export const cleanupStaleEnrollmentArtifacts = async (
  now = Date.now(),
): Promise<void> => {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SESSION_ROOT_PREFIX)) {
      continue;
    }
    const path = join(tmpdir(), entry.name);
    const metadata = await lstat(path).catch(() => undefined);
    if (
      metadata &&
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      now - metadata.mtimeMs >= STALE_SESSION_MAX_AGE_MS &&
      (await hasValidSessionMarker(path))
    ) {
      await removeSessionRoot(path).catch(() => undefined);
    }
  }
};

const writePrivateFile = async (
  path: string,
  content: string,
): Promise<string> => {
  await writeFileAtomically(path, content);
  await chmod(path, 0o600).catch(() => undefined);
  return sha256(content);
};

const copyStableProviderStateFile = async (
  source: string,
  target: string,
  label: string,
  expectedDigest?: string,
  transform?: (content: Buffer) => Buffer | string,
): Promise<boolean> => {
  const content = await readStableRegularFile(
    source,
    MAX_PROVIDER_STATE_BYTES,
    `${label} state`,
  );
  if (content === undefined) return false;
  const observedDigest = sha256(content);
  if (expectedDigest !== undefined && observedDigest !== expectedDigest) {
    throw new Error(`${label} state changed after instruction-plan review.`);
  }
  await writeFileAtomically(target, transform?.(content) ?? content);
  await chmod(target, 0o600).catch(() => undefined);
  return true;
};

const isOptionalProviderStateError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
};

const copyCodexAuthentication = async (codexHome: string): Promise<void> => {
  const configuredHome = process.env.CODEX_HOME?.trim();
  const userHome = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  const sourceHome =
    configuredHome ||
    (userHome
      ? join(userHome, ".codex")
      : join(dirname(getUserConfigPath()), "..", ".codex"));
  try {
    await copyStableProviderStateFile(
      join(sourceHome, "auth.json"),
      join(codexHome, "auth.json"),
      "Codex",
    );
  } catch (error) {
    if (!isOptionalProviderStateError(error)) {
      throw error;
    }
    // Environment tokens and OS credential stores do not require auth.json.
  }
};

const copyCopilotAuthentication = async (
  copilotHome: string,
): Promise<void> => {
  const sourceHome =
    process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
  const source = join(sourceHome, "config.json");
  try {
    const copied = await copyStableProviderStateFile(
      source,
      join(copilotHome, "config.json"),
      "Copilot",
      undefined,
      (content) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            decodeStrictUtf8(content, "Copilot internal state"),
          );
        } catch (error) {
          throw new Error(
            "Copilot internal state must be a valid JSON object before authentication state can be isolated.",
            { cause: error },
          );
        }
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          throw new Error(
            "Copilot internal state must be a valid JSON object before authentication state can be isolated.",
          );
        }

        const isolated = Object.create(null) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (
            key === "installedPlugins" ||
            key === "enabledPlugins" ||
            key === "extraKnownMarketplaces"
          ) {
            continue;
          }
          isolated[key] = value;
        }
        return `${JSON.stringify(isolated, null, 2)}\n`;
      },
    );
    void copied;
  } catch (error) {
    // Invalid or unavailable provider state is never copied into the isolated
    // run. Environment tokens and OS credential stores remain available.
    void error;
  }
};

const readCopilotWorkspaceMcpNames = async (
  workspaceRoot: string,
  projectedNames: ReadonlySet<string>,
): Promise<string[]> => {
  const names = new Set<string>();
  const canonicalWorkspace = resolve(workspaceRoot);
  let gitRoot: string | undefined;
  let ancestor = canonicalWorkspace;
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      const marker = await lstat(join(ancestor, ".git"));
      if (
        marker.isSymbolicLink() ||
        (!marker.isDirectory() && !marker.isFile())
      ) {
        throw new Error("the Git marker is linked or not a regular path");
      }
      gitRoot = ancestor;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Copilot MCP isolation could not inspect the Git boundary at ${ancestor}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }

  let directory = canonicalWorkspace;
  let filesVisited = 0;
  let disableArgumentBytes = 0;

  while (true) {
    for (const relativePath of [".mcp.json", join(".github", "mcp.json")]) {
      const path = join(directory, relativePath);
      let content;
      try {
        content = await readStableRegularFile(
          path,
          MAX_PROVIDER_STATE_BYTES,
          "Copilot MCP configuration",
        );
      } catch (error) {
        throw new Error(
          `Copilot MCP isolation could not inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (content === undefined) continue;
      filesVisited += 1;
      if (filesVisited > MAX_COPILOT_WORKSPACE_MCP_FILES) {
        throw new Error(
          "Copilot MCP isolation exceeded the bounded workspace configuration-file count.",
        );
      }
      const text = decodeStrictUtf8(
        content,
        `Copilot MCP configuration at ${path}`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `Copilot MCP configuration is malformed JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const mcpServers =
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).mcpServers === "object" &&
        (parsed as Record<string, unknown>).mcpServers !== null &&
        !Array.isArray((parsed as Record<string, unknown>).mcpServers)
          ? ((parsed as Record<string, unknown>).mcpServers as Record<
              string,
              unknown
            >)
          : {};
      for (const name of Object.keys(mcpServers)) {
        if (projectedNames.has(name)) {
          continue;
        }
        if (
          name.length === 0 ||
          hasInvalidCopilotMcpServerNameCharacter(name) ||
          Buffer.from(name, "utf8").toString("utf8") !== name
        ) {
          throw new Error(
            `Copilot MCP server name ${JSON.stringify(name)} is outside Copilot CLI's documented printable-name contract and cannot be disabled safely.`,
          );
        }
        if (!names.has(name)) {
          disableArgumentBytes += Buffer.byteLength(
            `--disable-mcp-server=${name}`,
            "utf8",
          );
          if (disableArgumentBytes > MAX_COPILOT_DISABLE_MCP_ARGUMENT_BYTES) {
            throw new Error(
              `Copilot MCP isolation exceeds the ${MAX_COPILOT_DISABLE_MCP_ARGUMENT_BYTES}-byte portable command-argument bound.`,
            );
          }
          names.add(name);
        }
        if (names.size > MAX_COPILOT_WORKSPACE_MCP_SERVERS) {
          throw new Error(
            "Copilot MCP isolation exceeded the bounded workspace server count.",
          );
        }
      }
    }
    if (directory === gitRoot || gitRoot === undefined) {
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return [...names].sort(compareCanonicalStrings);
};

const getMcpServers = (projection: McpProjection): Record<string, unknown> => {
  const value = projection.config.mcpServers;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const renderCodexUntrustedProjectsToml = (workspaceRoot: string): string => {
  const paths: string[] = [];
  let path = resolve(workspaceRoot);

  while (true) {
    paths.push(path);
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }

  return paths
    .map(
      (projectPath) =>
        `[projects.${quoteTomlKey(projectPath)}]\ntrust_level = "untrusted"`,
    )
    .join("\n\n");
};

const renderCodexEnrollment = async (
  rootPath: string,
  systemInstructions: string,
  projection: McpProjection,
  workspaceRoot: string,
): Promise<RenderedEnrollmentFiles> => {
  const codexHome = join(rootPath, "codex-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await copyCodexAuthentication(codexHome);
  const configPath = join(codexHome, "config.toml");
  const content = [
    `developer_instructions = ${JSON.stringify(systemInstructions)}`,
    "project_doc_max_bytes = 0",
    "project_doc_fallback_filenames = []",
    renderCodexUntrustedProjectsToml(workspaceRoot),
    renderCodexMcpToml(getMcpServers(projection)),
  ]
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .concat("\n");
  return {
    args: [
      "--config",
      "project_doc_max_bytes=0",
      "--config",
      "project_doc_fallback_filenames=[]",
    ],
    env: { CODEX_HOME: codexHome },
    route: "codex-developer-config",
    files: [
      {
        path: configPath,
        digest: await writePrivateFile(configPath, content),
        purpose:
          "Run-scoped Codex developer instructions and MCP configuration",
      },
    ],
  };
};

const renderClaudeEnrollment = async (
  rootPath: string,
  systemInstructions: string,
  projection: McpProjection,
  features: ReadonlySet<string>,
): Promise<RenderedEnrollmentFiles> => {
  const claudeHome = join(rootPath, "claude-home");
  await mkdir(claudeHome, { recursive: true, mode: 0o700 });
  const instructionPath = join(rootPath, "system-prompt.md");
  const mcpPath = join(rootPath, "mcp.json");
  const instructionDigest = await writePrivateFile(
    instructionPath,
    systemInstructions,
  );
  await writeJsonAtomically(mcpPath, projection.config);
  await chmod(mcpPath, 0o600).catch(() => undefined);
  const args = [
    ...(canUseClaudeBareMode(features) ? ["--bare"] : []),
    "--setting-sources",
    "",
    "--append-system-prompt-file",
    instructionPath,
    "--mcp-config",
    mcpPath,
    "--strict-mcp-config",
  ];
  return {
    args,
    env: {
      CLAUDE_CONFIG_DIR: claudeHome,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    },
    route: "claude-system-prompt-file",
    files: [
      {
        path: instructionPath,
        digest: instructionDigest,
        purpose: "Run-scoped Claude appended system prompt",
      },
      {
        path: mcpPath,
        digest: sha256(`${JSON.stringify(projection.config, null, 2)}\n`),
        purpose: "Run-scoped Claude MCP configuration",
      },
    ],
  };
};

const renderCopilotEnrollment = async (
  rootPath: string,
  systemInstructions: string,
  projection: McpProjection,
  workspaceRoot: string,
): Promise<RenderedEnrollmentFiles> => {
  const copilotHome = join(rootPath, "copilot-home");
  const copilotCacheHome = join(rootPath, "copilot-cache");
  await Promise.all([
    mkdir(copilotHome, { recursive: true, mode: 0o700 }),
    mkdir(copilotCacheHome, { recursive: true, mode: 0o700 }),
  ]);
  await copyCopilotAuthentication(copilotHome);
  const agentId = `machdoch-${sha256(rootPath).slice(0, 24)}`;
  const agentsPath = join(copilotHome, "agents");
  await mkdir(agentsPath, { recursive: true, mode: 0o700 });
  const agentPath = join(agentsPath, `${agentId}.agent.md`);
  const agentContent = [
    "---",
    `name: ${agentId}`,
    "description: Invocation-scoped Machdoch instruction adapter",
    "infer: false",
    "---",
    systemInstructions,
    "",
  ].join("\n");
  const agentDigest = await writePrivateFile(agentPath, agentContent);
  const mcpPath = join(rootPath, "mcp.json");
  await writeJsonAtomically(mcpPath, projection.config);
  await chmod(mcpPath, 0o600).catch(() => undefined);
  const projectedNames = new Set(projection.servers.map((server) => server.id));
  const disabledWorkspaceServers = await readCopilotWorkspaceMcpNames(
    workspaceRoot,
    projectedNames,
  );
  return {
    args: [
      "--no-auto-update",
      "--no-custom-instructions",
      `--agent=${agentId}`,
      `--additional-mcp-config=@${mcpPath}`,
      "--disable-builtin-mcps",
      ...disabledWorkspaceServers.map((name) => `--disable-mcp-server=${name}`),
    ],
    env: {
      COPILOT_HOME: copilotHome,
      COPILOT_CACHE_HOME: copilotCacheHome,
      COPILOT_PLUGIN_DIR_ONLY: "true",
    },
    route: "copilot-custom-agent",
    files: [
      {
        path: agentPath,
        digest: agentDigest,
        purpose: "Run-scoped Copilot custom-agent instructions",
      },
      {
        path: mcpPath,
        digest: sha256(`${JSON.stringify(projection.config, null, 2)}\n`),
        purpose: "Run-scoped Copilot MCP configuration",
      },
    ],
  };
};

const renderEnrollment = async (
  provider: AgentCliProvider,
  rootPath: string,
  systemInstructions: string,
  projection: McpProjection,
  workspaceRoot: string,
  features: ReadonlySet<string>,
): Promise<RenderedEnrollmentFiles> => {
  switch (provider) {
    case "codex-cli":
      return renderCodexEnrollment(
        rootPath,
        systemInstructions,
        projection,
        workspaceRoot,
      );
    case "claude-cli":
      return renderClaudeEnrollment(
        rootPath,
        systemInstructions,
        projection,
        features,
      );
    case "copilot-cli":
      return renderCopilotEnrollment(
        rootPath,
        systemInstructions,
        projection,
        workspaceRoot,
      );
  }
};

const createMcpCoverage = (
  params: MaterializeCliEnrollmentParams,
  projection: McpProjection,
): EnrollmentCoverageEntry[] => {
  return projection.servers.map((server) => ({
    entityId: `mcp-server:${server.canonicalId}`,
    entityKind: "mcp-server",
    provider: params.provider,
    digest: server.digest,
    route: server.route,
    fidelity: "exact",
    refreshState: "filesystem-current",
    covered: true,
    capabilities: server.capabilities,
    evidence: [
      {
        kind: "file-hash",
        detail: "Run-scoped provider MCP configuration",
        digest: server.digest,
      },
    ],
    ...(server.warnings.length === 0
      ? {}
      : { warning: server.warnings.join(" ") }),
  }));
};

const createMaterializedInstructionDelivery = (
  params: MaterializeCliEnrollmentParams,
  transportRoute: RenderedEnrollmentFiles["route"],
  instructionPayloadBytes: number,
  instructionPayloadIncludedInRequest: boolean,
): MaterializedInstructionDelivery => ({
  resolutionId: params.resolution.resolutionId,
  planId: params.deliveryPlan.planId,
  canonicalDigest: params.resolution.canonicalDigest,
  environmentDigest: params.resolution.environmentDigest,
  grade: params.deliveryPlan.grade,
  planRoute: params.deliveryPlan.route,
  transportRoute,
  envelopeBytes: params.resolution.budget.envelopeBytes,
  instructionPayloadBytes,
  instructionPayloadIncludedInRequest,
  ...((params.resolution.budget.estimatedTotalInstructionTokens ??
    params.resolution.budget.estimatedTokens) === undefined
    ? {}
    : {
        estimatedTokens:
          params.resolution.budget.estimatedTotalInstructionTokens ??
          params.resolution.budget.estimatedTokens,
      }),
  truncation: "none",
  sources: params.resolution.selectedSources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    scopePath: source.scopePath,
    precedence: source.precedence,
    digest: source.digest,
    byteLength: source.byteLength,
    lineCount: source.lineCount,
  })),
  dimensions: params.deliveryPlan.dimensions.map((dimension) => ({
    ...dimension,
  })),
});

const redactArgumentValues = (args: readonly string[]): string[] =>
  args.map((arg) =>
    arg.startsWith("--") ? (arg.split("=")[0] ?? arg) : "<value>",
  );

export const materializeCliEnrollment = async (
  params: MaterializeCliEnrollmentParams,
): Promise<MaterializedCliEnrollment> => {
  if (
    params.resolution.providerId !== params.provider ||
    params.resolution.surface !== "cli" ||
    params.deliveryPlan.resolutionId !== params.resolution.resolutionId ||
    params.deliveryPlan.providerId !== params.resolution.providerId ||
    params.deliveryPlan.surface !== params.resolution.surface ||
    params.deliveryPlan.canonicalDigest !== params.resolution.canonicalDigest ||
    params.deliveryPlan.environmentDigest !==
      params.resolution.environmentDigest ||
    params.runtimeSystemInstructions.trim().length === 0
  ) {
    throw new Error(
      "CLI materialization requires matching frozen instructions, a delivery plan, and non-empty run-scoped system instructions.",
    );
  }
  if (
    params.deliveryPlan.grade === "unsupported" ||
    params.deliveryPlan.blockingReasons.length > 0
  ) {
    throw new Error(
      `The selected CLI cannot satisfy the native instruction contract: ${params.deliveryPlan.blockingReasons.join(" ") || "the reviewed delivery plan is unsupported."}`,
    );
  }
  await cleanupStaleEnrollmentArtifacts();
  const rootPath = await mkdtemp(join(tmpdir(), SESSION_ROOT_PREFIX));
  await chmod(rootPath, 0o700).catch(() => undefined);
  await writeJsonAtomically(join(rootPath, SESSION_MARKER_NAME), {
    schemaVersion: SESSION_MARKER_SCHEMA_VERSION,
    kind: "machdoch-instruction-run",
    runId: params.runId,
    rootPath,
    createdAt: new Date().toISOString(),
  });
  await chmod(join(rootPath, SESSION_MARKER_NAME), 0o600).catch(
    () => undefined,
  );

  try {
    const [probe, projection] = await Promise.all([
      probeProviderCli(params.provider, params.executable, { force: true }),
      projectMcpForProvider(params.provider, params.workspaceRoot),
    ]);
    const probedCapability = createCliInstructionCapabilityFromProbe(
      params.resolution,
      probe,
    );
    const probedPlan = createInstructionDeliveryPlan(params.resolution, {
      capability: probedCapability,
    });
    if (
      probedPlan.grade === "unsupported" ||
      probedPlan.blockingReasons.length > 0
    ) {
      throw new Error(
        `The selected CLI cannot satisfy the native instruction contract: ${probedPlan.blockingReasons.join(" ") || "the current provider probe is unsupported."}`,
      );
    }
    if (probedPlan.planId !== params.deliveryPlan.planId) {
      throw new Error(
        "The provider capability probe changed after instruction preflight; Machdoch blocked the invocation instead of using an unreviewed delivery route.",
      );
    }
    const instructionPayload = renderInstructionTransportPayload(
      params.resolution.renderedEnvelope,
      params.resolution.mcpInitializationInstructions,
    );
    const systemInstructions = [
      params.runtimeSystemInstructions.trim(),
      instructionPayload,
    ].join("\n\n");
    const providerFeatures = new Set(probe.features);
    const rendered = await renderEnrollment(
      params.provider,
      rootPath,
      systemInstructions,
      projection,
      params.workspaceRoot,
      providerFeatures,
    );
    const instructionDelivery = createMaterializedInstructionDelivery(
      params,
      rendered.route,
      Buffer.byteLength(instructionPayload, "utf8"),
      true,
    );
    const sortedProviderFeatures = [...probe.features].sort(
      compareCanonicalStrings,
    );
    const providerProbeDigest = sha256(
      JSON.stringify({
        provider: probe.provider,
        executable: probe.executable,
        version: probe.version ?? null,
        features: sortedProviderFeatures,
      }),
    );
    const coverage = createMcpCoverage(params, projection);
    const coverageSummary = summarizeEnrollmentCoverage(coverage);
    const manifestPath = join(rootPath, "enrollment-manifest.json");
    const manifest: EnrollmentManifest = {
      schemaVersion: PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION,
      runId: params.runId,
      provider: params.provider,
      ...(probe.version === undefined
        ? {}
        : { providerVersion: probe.version }),
      providerFeatures: sortedProviderFeatures,
      providerProbeDigest,
      workspaceId:
        params.resolution.workspaceId ??
        `unregistered:${sha256(params.workspaceRoot).slice(0, 20)}`,
      createdAt: new Date().toISOString(),
      instructionDelivery,
      mcp: {
        effectiveConfigDigest: projection.effectiveConfigDigest,
        catalogDigest: projection.catalogDigest,
        servers: projection.servers.map((server) => ({
          id: server.id,
          canonicalId: server.canonicalId,
          digest: server.digest,
          route: server.route,
          capabilities: server.capabilities,
        })),
      },
      renderedFiles: rendered.files,
      nativeSources: params.resolution.nativeInventory.map((record) => ({
        path: record.path,
        location: record.location,
        convention: record.convention,
        status: record.status,
        ...(record.digest === undefined ? {} : { digest: record.digest }),
      })),
      arguments: redactArgumentValues(rendered.args),
      environmentKeys: Object.keys(rendered.env).sort(),
      coverage,
      coverageSummary,
      warnings: [
        ...params.resolution.budget.advisories,
        ...projection.warnings,
        ...probe.warnings,
        ...probedPlan.dimensions
          .filter((entry) => entry.status !== "satisfied")
          .map((entry) => `${entry.name}: ${entry.detail}`),
      ],
    };
    await writeJsonAtomically(manifestPath, manifest);
    await chmod(manifestPath, 0o600).catch(() => undefined);

    return {
      provider: params.provider,
      rootPath,
      instructionDelivery,
      instructionRoute: rendered.route,
      mcpProjection: projection,
      args: rendered.args,
      env: rendered.env,
      manifest,
      manifestPath,
      dispose: async (): Promise<void> => {
        await removeSessionRoot(rootPath).catch(() => undefined);
      },
    };
  } catch (error) {
    await removeSessionRoot(rootPath).catch(() => undefined);
    throw error;
  }
};
