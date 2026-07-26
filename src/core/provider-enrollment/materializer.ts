import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
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
import { inventoryNativeInstructions } from "../instruction-system/native-inventory.js";
import { canonicalDigest } from "../instruction-system/normalization.js";
import {
  loadMcpInitializationInstructionSnapshot,
  mcpInitializationInstructionSnapshotDigest,
  renderInstructionTransportPayload,
} from "../mcp/initialization-instructions.js";
import {
  writeFileAtomically,
  writeJsonAtomically,
} from "../_helpers/write-file-atomically.helper.js";
import { readOpenedFileExactly } from "../_helpers/read-opened-file-exactly.helper.js";
import { probeProviderCli } from "./capability-registry.js";
import {
  claudePlanUsesSubagentEnvelope,
  createCodexDeveloperInstructionOverride,
  createCliInstructionCapabilityFromProbe,
} from "./instruction-delivery-preflight.js";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import { compareCanonicalStrings, sha256 } from "./digests.js";
import { projectMcpForProvider } from "./mcp-projector.js";
import { renderCodexMcpToml } from "./toml.js";
import {
  PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION,
  type EnrollmentCoverageEntry,
  type EnrollmentManifest,
  type MaterializedInstructionDelivery,
  type MaterializedCliEnrollment,
  type McpProjection,
  type ProviderProbeResult,
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
}

interface RenderedEnrollmentFiles {
  args: string[];
  env: NodeJS.ProcessEnv;
  promptFallback?: string;
  route: "cli-native-instruction" | "cli-prompt-fallback";
  files: Array<{ path: string; digest: string; purpose: string }>;
}

interface ReviewedProviderState {
  present: boolean;
  digest?: string;
}

const REQUIRED_ENROLLMENT_FEATURES: Record<
  AgentCliProvider,
  readonly string[]
> = {
  "codex-cli": ["--config"],
  "claude-cli": [
    "--append-system-prompt-file",
    "--mcp-config",
    "--strict-mcp-config",
  ],
  "copilot-cli": [
    "--no-auto-update",
    "--no-custom-instructions",
    "--additional-mcp-config",
    "--disable-builtin-mcps",
    "--disable-mcp-server",
  ],
};

const assertProbeSupportsEnrollment = (
  provider: AgentCliProvider,
  executable: string,
  probe: ProviderProbeResult,
): void => {
  if (
    probe.provider !== provider ||
    probe.executable !== executable ||
    !probe.available
  ) {
    throw new Error(
      `The ${provider} executable could not be version/help probed for run-scoped instruction delivery.`,
    );
  }
  const missing = REQUIRED_ENROLLMENT_FEATURES[provider].filter(
    (feature) => !probe.features.includes(feature),
  );
  if (missing.length > 0) {
    throw new Error(
      `The probed ${provider} surface does not expose required complete-delivery flag(s): ${missing.join(", ")}. Machdoch will not invoke it with a partial or speculative fallback.`,
    );
  }
};

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

const sameFileIdentity = (
  before: {
    dev: number | bigint;
    ino: number | bigint;
    size: number | bigint;
    mtimeMs: number;
  },
  after: {
    dev: number | bigint;
    ino: number | bigint;
    size: number | bigint;
    mtimeMs: number;
  },
): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs;

const readStableRegularFile = async (
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer | undefined> => {
  let beforePath;
  try {
    beforePath = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !beforePath.isFile() ||
    beforePath.isSymbolicLink() ||
    beforePath.size > maxBytes
  ) {
    throw new Error(
      `${label} must be a regular, unlinked file no larger than ${maxBytes} bytes: ${path}`,
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const beforeOpened = await handle.stat();
    if (!sameFileIdentity(beforePath, beforeOpened)) {
      throw new Error(`${label} changed before it could be opened safely: ${path}`);
    }
    const content = await readOpenedFileExactly(handle, beforeOpened.size);
    const [afterOpened, afterPath] = await Promise.all([
      handle.stat(),
      lstat(path),
    ]);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileIdentity(beforeOpened, afterOpened) ||
      !sameFileIdentity(beforeOpened, afterPath)
    ) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    return content;
  } finally {
    await handle?.close();
  }
};

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
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
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
  if (
    expectedDigest !== undefined &&
    observedDigest !== expectedDigest
  ) {
    throw new Error(
      `${label} state changed after instruction-plan review.`,
    );
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
  reviewedConfig: ReviewedProviderState,
): Promise<void> => {
  if (reviewedConfig.present && reviewedConfig.digest === undefined) {
    throw new Error(
      "Reviewed Copilot internal state could not be read and hashed safely.",
    );
  }
  const sourceHome =
    process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
  const source = join(sourceHome, "config.json");
  try {
    const copied = await copyStableProviderStateFile(
      source,
      join(copilotHome, "config.json"),
      "Copilot",
      reviewedConfig.digest,
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
    if (copied && !reviewedConfig.present) {
      throw new Error(
        "Copilot internal state appeared after instruction-plan review.",
      );
    }
    if (!copied && reviewedConfig.present) {
      throw new Error(
        "Reviewed Copilot internal state could not be copied safely.",
      );
    }
  } catch (error) {
    if (
      !isOptionalProviderStateError(error) ||
      reviewedConfig.present
    ) {
      throw error;
    }
    // Environment tokens and OS credential stores do not require config.json.
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
          if (
            disableArgumentBytes > MAX_COPILOT_DISABLE_MCP_ARGUMENT_BYTES
          ) {
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

const renderCodexEnrollment = async (
  rootPath: string,
  envelope: string,
  projection: McpProjection,
): Promise<RenderedEnrollmentFiles> => {
  const developerOverride =
    createCodexDeveloperInstructionOverride(envelope);
  if (developerOverride === undefined) {
    throw new Error(
      "The complete Codex developer-instruction override exceeds the safe command-argument bound.",
    );
  }
  const codexHome = join(rootPath, "codex-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await copyCodexAuthentication(codexHome);
  const configPath = join(codexHome, "config.toml");
  const content = [
    `developer_instructions = ${JSON.stringify(envelope)}`,
    renderCodexMcpToml(getMcpServers(projection)),
  ]
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .concat("\n");
  return {
    args: ["--config", developerOverride],
    env: { CODEX_HOME: codexHome },
    route: "cli-native-instruction",
    files: [
      {
        path: configPath,
        digest: await writePrivateFile(configPath, content),
        purpose: "Run-scoped Codex developer instructions and MCP configuration",
      },
    ],
  };
};

const assertNativeInventoryCurrent = async (
  params: MaterializeCliEnrollmentParams,
): Promise<void> => {
  const locals = params.resolution.selectedSources
    .filter(
      (source): source is (typeof params.resolution.selectedSources)[number] & {
        relativePath: string;
      } => source.kind === "project-local" && source.relativePath !== undefined,
    )
    .map((source) => ({
      id: source.id,
      relativePath: source.relativePath,
      scopePath: source.scopePath,
      body: source.body,
      digest: source.digest,
      byteLength: source.byteLength,
      lineCount: source.lineCount,
      identity: `frozen:${source.digest}`,
    }));
  const [current, currentMcpInitializationInstructions] = await Promise.all([
    inventoryNativeInstructions({
      workspaceRoot: params.workspaceRoot,
      providerId: params.provider,
      surface: "cli",
      locals,
    }),
    loadMcpInitializationInstructionSnapshot(params.workspaceRoot),
  ]);
  if (
    canonicalDigest(current) !==
    canonicalDigest(params.resolution.nativeInventory)
  ) {
    throw new Error(
      "Provider-native instructions or configuration changed after instruction-plan review. Refresh resolution and review the new delivery plan before launch.",
    );
  }
  if (
    mcpInitializationInstructionSnapshotDigest(
      currentMcpInitializationInstructions,
    ) !==
    mcpInitializationInstructionSnapshotDigest(
      params.resolution.mcpInitializationInstructions,
    )
  ) {
    throw new Error(
      "MCP initialization instructions changed after instruction-plan review. Refresh resolution and review the new delivery plan before launch.",
    );
  }
};

const renderClaudeEnrollment = async (
  rootPath: string,
  envelope: string,
  projection: McpProjection,
  deliveryPlan: InstructionDeliveryPlan,
): Promise<RenderedEnrollmentFiles> => {
  const instructionPath = join(rootPath, "system-prompt.md");
  const mcpPath = join(rootPath, "mcp.json");
  const instructionDigest = await writePrivateFile(instructionPath, envelope);
  await writeJsonAtomically(mcpPath, projection.config);
  await chmod(mcpPath, 0o600).catch(() => undefined);
  const args = [
    ...(deliveryPlan.capability.nativeDiscovery === "suppressed"
      ? ["--bare"]
      : []),
    "--append-system-prompt-file",
    instructionPath,
    ...(claudePlanUsesSubagentEnvelope(deliveryPlan.capability)
      ? ["--append-subagent-system-prompt", envelope]
      : []),
    "--mcp-config",
    mcpPath,
    "--strict-mcp-config",
  ];
  return {
    args,
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    route: "cli-native-instruction",
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
  envelope: string,
  projection: McpProjection,
  workspaceRoot: string,
  reviewedConfig: ReviewedProviderState,
): Promise<RenderedEnrollmentFiles> => {
  const copilotHome = join(rootPath, "copilot-home");
  const copilotCacheHome = join(rootPath, "copilot-cache");
  await Promise.all([
    mkdir(copilotHome, { recursive: true, mode: 0o700 }),
    mkdir(copilotCacheHome, { recursive: true, mode: 0o700 }),
  ]);
  await copyCopilotAuthentication(copilotHome, reviewedConfig);
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
      `--additional-mcp-config=@${mcpPath}`,
      "--disable-builtin-mcps",
      ...disabledWorkspaceServers.map(
        (name) => `--disable-mcp-server=${name}`,
      ),
    ],
    env: {
      COPILOT_HOME: copilotHome,
      COPILOT_CACHE_HOME: copilotCacheHome,
      COPILOT_PLUGIN_DIR_ONLY: "true",
    },
    promptFallback: envelope,
    route: "cli-prompt-fallback",
    files: [
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
  envelope: string,
  projection: McpProjection,
  deliveryPlan: InstructionDeliveryPlan,
  workspaceRoot: string,
  reviewedCopilotConfig: ReviewedProviderState,
): Promise<RenderedEnrollmentFiles> => {
  switch (provider) {
    case "codex-cli":
      return renderCodexEnrollment(rootPath, envelope, projection);
    case "claude-cli":
      return renderClaudeEnrollment(
        rootPath,
        envelope,
        projection,
        deliveryPlan,
      );
    case "copilot-cli":
      return renderCopilotEnrollment(
        rootPath,
        envelope,
        projection,
        workspaceRoot,
        reviewedCopilotConfig,
      );
  }
};

const createMcpCoverage = (
  params: MaterializeCliEnrollmentParams,
  projection: McpProjection,
): EnrollmentCoverageEntry[] => {
  return projection.servers.map(
    (server) => ({
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
    }),
  );
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
  ...((
    params.resolution.budget.estimatedTotalInstructionTokens ??
    params.resolution.budget.estimatedTokens
  ) === undefined
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
    arg.startsWith("--") ? (arg.split("=")[0] ?? arg) : "<value>"
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
    params.deliveryPlan.grade === "unsupported" ||
    params.deliveryPlan.blockingReasons.length > 0
  ) {
    throw new Error(
      "CLI materialization requires a matching frozen resolution and delivery plan.",
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
  await chmod(join(rootPath, SESSION_MARKER_NAME), 0o600).catch(() => undefined);

  try {
    const [probe, projection] = await Promise.all([
      probeProviderCli(params.provider, params.executable, { force: true }),
      projectMcpForProvider(params.provider, params.workspaceRoot),
      assertNativeInventoryCurrent(params),
    ]);
    assertProbeSupportsEnrollment(
      params.provider,
      params.executable,
      probe,
    );
    const probedCapability = createCliInstructionCapabilityFromProbe(
      params.resolution,
      probe,
    );
    const probedPlan = createInstructionDeliveryPlan(params.resolution, {
      capability: probedCapability,
    });
    if (probedPlan.planId !== params.deliveryPlan.planId) {
      throw new Error(
        `The ${params.provider} executable capability/version changed after instruction-plan review (reviewed ${params.deliveryPlan.planId}, observed ${probedPlan.planId}). Refresh and acknowledge the new delivery plan before launch.`,
      );
    }
    const instructionPayload = renderInstructionTransportPayload(
      params.resolution.renderedEnvelope,
      params.resolution.mcpInitializationInstructions,
    );
    const reviewedCopilotConfig = params.resolution.nativeInventory.find(
      (record) =>
        record.location === "user" &&
        record.convention === "copilot-user-internal-state",
    );
    const rendered = await renderEnrollment(
      params.provider,
      rootPath,
      instructionPayload,
      projection,
      params.deliveryPlan,
      params.workspaceRoot,
      reviewedCopilotConfig === undefined
        ? { present: false }
        : {
            present: true,
            ...(reviewedCopilotConfig.digest === undefined
              ? {}
              : { digest: reviewedCopilotConfig.digest }),
          },
    );
    const instructionDelivery = createMaterializedInstructionDelivery(
      params,
      rendered.route,
      Buffer.byteLength(instructionPayload, "utf8"),
      params.provider !== "claude-cli" ||
        claudePlanUsesSubagentEnvelope(params.deliveryPlan.capability),
    );
    const providerFeatures = [...probe.features].sort(compareCanonicalStrings);
    const providerProbeDigest = sha256(
      JSON.stringify({
        provider: probe.provider,
        executable: probe.executable,
        version: probe.version ?? null,
        features: providerFeatures,
      }),
    );
    const coverage = createMcpCoverage(params, projection);
    const coverageSummary = summarizeEnrollmentCoverage(coverage);
    const manifestPath = join(rootPath, "enrollment-manifest.json");
    const manifest: EnrollmentManifest = {
      schemaVersion: PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION,
      runId: params.runId,
      provider: params.provider,
      ...(probe.version === undefined ? {} : { providerVersion: probe.version }),
      providerFeatures,
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
        ...params.deliveryPlan.dimensions
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
      ...(rendered.promptFallback === undefined
        ? {}
        : { promptFallback: rendered.promptFallback }),
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
