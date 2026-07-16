import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "../env.js";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import type { ResolvedTaskContext } from "../types.js";
import { writeFileAtomically, writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import { probeProviderCli } from "./capability-registry.js";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import { sha256 } from "./digests.js";
import {
  compileInstructionBundle,
  renderCompiledInstructionSources,
} from "./instruction-compiler.js";
import { scanNativeInstructionSources } from "./native-source-scanner.js";
import { projectMcpForProvider } from "./mcp-projector.js";
import { renderCodexMcpToml } from "./toml.js";
import {
  PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION,
  type EnrollmentCoverageEntry,
  type EnrollmentManifest,
  type MaterializedCliEnrollment,
  type McpProjection,
} from "./types.js";

const SESSION_ROOT_PREFIX = "machdoch-provider-enrollment-";
const STALE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

interface MaterializeCliEnrollmentParams {
  provider: AgentCliProvider;
  executable: string;
  runId: string;
  workspaceRoot: string;
  taskContext: ResolvedTaskContext;
  additionalSystemPromptSections?: readonly string[];
  codexInstructionFallback?: boolean;
}

interface RenderedEnrollmentFiles {
  args: string[];
  env: NodeJS.ProcessEnv;
  files: Array<{ path: string; digest: string; purpose: string }>;
}

export const cleanupStaleEnrollmentArtifacts = async (
  now = Date.now(),
): Promise<void> => {
  const root = tmpdir();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SESSION_ROOT_PREFIX))
    .map(async (entry) => {
      const path = join(root, entry.name);
      const metadata = await stat(path).catch(() => undefined);
      if (metadata && now - metadata.mtimeMs >= STALE_SESSION_MAX_AGE_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }));
};

const writePrivateFile = async (path: string, content: string): Promise<string> => {
  await writeFileAtomically(path, content);
  await chmod(path, 0o600).catch(() => undefined);
  return sha256(content);
};

const getCodexSourceHome = (): string => {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured) return configured;
  return join(dirname(getUserConfigPath()), "..", ".codex");
};

const copyCodexAuthentication = async (codexHome: string): Promise<void> => {
  const sourceHome = process.env.CODEX_HOME?.trim();
  const userHome = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  const resolvedSource = sourceHome || (userHome ? join(userHome, ".codex") : getCodexSourceHome());
  try {
    const target = join(codexHome, "auth.json");
    await copyFile(join(resolvedSource, "auth.json"), target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch {
    // Token environment variables and OS credential stores do not need auth.json.
  }
};

const getMcpServers = (projection: McpProjection): Record<string, unknown> => {
  const value = projection.config.mcpServers;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const renderCodexEnrollment = async (
  rootPath: string,
  bundleText: string,
  projection: McpProjection,
  useAgentsFallback: boolean,
): Promise<RenderedEnrollmentFiles> => {
  const codexHome = join(rootPath, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await chmod(codexHome, 0o700).catch(() => undefined);
  await copyCodexAuthentication(codexHome);
  const configPath = join(codexHome, "config.toml");
  const mcpToml = renderCodexMcpToml(getMcpServers(projection));
  const content = [
    useAgentsFallback
      ? undefined
      : `developer_instructions = ${JSON.stringify(bundleText)}`,
    mcpToml,
  ]
    .filter(Boolean)
    .join("\n\n") + "\n";
  const digest = await writePrivateFile(configPath, content);
  const files = [{
    path: configPath,
    digest,
    purpose: useAgentsFallback
      ? "Codex MCP configuration"
      : "Codex developer instructions and MCP",
  }];
  if (useAgentsFallback) {
    const instructionPath = join(codexHome, "AGENTS.md");
    files.push({
      path: instructionPath,
      digest: await writePrivateFile(instructionPath, `${bundleText}\n`),
      purpose: "Codex isolated-home AGENTS fallback",
    });
  }

  return {
    args: [],
    env: { CODEX_HOME: codexHome },
    files,
  };
};

const renderClaudeEnrollment = async (
  rootPath: string,
  bundleText: string,
  projection: McpProjection,
): Promise<RenderedEnrollmentFiles> => {
  const instructionPath = join(rootPath, "system-prompt.md");
  const mcpPath = join(rootPath, "mcp.json");
  const instructionDigest = await writePrivateFile(instructionPath, `${bundleText}\n`);
  await writeJsonAtomically(mcpPath, projection.config);
  await chmod(mcpPath, 0o600).catch(() => undefined);
  const mcpDigest = sha256(`${JSON.stringify(projection.config, null, 2)}\n`);
  return {
    args: [
      "--append-system-prompt-file",
      instructionPath,
      "--mcp-config",
      mcpPath,
    ],
    env: {},
    files: [
      { path: instructionPath, digest: instructionDigest, purpose: "Claude appended system prompt" },
      { path: mcpPath, digest: mcpDigest, purpose: "Claude MCP configuration" },
    ],
  };
};

const renderCopilotEnrollment = async (
  rootPath: string,
  bundleText: string,
  projection: McpProjection,
): Promise<RenderedEnrollmentFiles> => {
  const instructionDirectory = join(rootPath, "custom-instructions");
  await mkdir(instructionDirectory, { recursive: true });
  const instructionPath = join(instructionDirectory, "AGENTS.md");
  const mcpPath = join(rootPath, "mcp.json");
  const instructionDigest = await writePrivateFile(instructionPath, `${bundleText}\n`);
  await writeJsonAtomically(mcpPath, projection.config);
  await chmod(mcpPath, 0o600).catch(() => undefined);
  const mcpDigest = sha256(`${JSON.stringify(projection.config, null, 2)}\n`);
  return {
    args: [
      `--additional-mcp-config=@${mcpPath}`,
      "--allow-all-mcp-server-instructions",
    ],
    env: {
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: instructionDirectory,
      GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: "true",
    },
    files: [
      { path: instructionPath, digest: instructionDigest, purpose: "Copilot custom instructions" },
      { path: mcpPath, digest: mcpDigest, purpose: "Copilot additional MCP configuration" },
    ],
  };
};

const renderEnrollment = async (
  provider: AgentCliProvider,
  rootPath: string,
  bundleText: string,
  projection: McpProjection,
  codexInstructionFallback: boolean,
): Promise<RenderedEnrollmentFiles> => {
  switch (provider) {
    case "codex-cli":
      return await renderCodexEnrollment(
        rootPath,
        bundleText,
        projection,
        codexInstructionFallback,
      );
    case "claude-cli":
      return await renderClaudeEnrollment(rootPath, bundleText, projection);
    case "copilot-cli":
      return await renderCopilotEnrollment(rootPath, bundleText, projection);
  }
};

const createCoverage = (
  provider: AgentCliProvider,
  instructionRoute: "cli-native-instruction",
  bundle: ReturnType<typeof compileInstructionBundle>,
  projection: McpProjection,
  adoptedSourceIds: ReadonlySet<string>,
  hasAllowedNativeSources: boolean,
): EnrollmentCoverageEntry[] => {
  const degradedSourceIds = new Set(bundle.degradedSourceIds);
  const entries: EnrollmentCoverageEntry[] = bundle.sources.flatMap((source) => source.sourceIds.map((sourceId) => ({
    entityId: sourceId,
    entityKind: "instruction",
    provider,
    digest: source.bodyHash,
    route: degradedSourceIds.has(source.id)
      ? "uncovered"
      : source.sourceIds.some((id) => adoptedSourceIds.has(id))
        ? "provider-native-adopted"
        : instructionRoute,
    fidelity: degradedSourceIds.has(source.id)
      ? "degraded"
      : hasAllowedNativeSources
        ? "baseline"
        : "exact",
    refreshState: degradedSourceIds.has(source.id) ? "degraded" : "filesystem-current",
    covered: !degradedSourceIds.has(source.id),
    evidence: [{
      kind: "file-hash",
      detail: source.sourceIds.some((id) => adoptedSourceIds.has(id))
        ? "Adopted provider-native instruction discovery"
        : "Provider-native instruction artifact",
      digest: bundle.digest,
    }],
    ...(degradedSourceIds.has(source.id)
      ? { warning: "Instruction content was truncated by the enrollment budget." }
      : hasAllowedNativeSources
        ? { warning: "Additional unmanaged provider-native instructions remain enabled." }
        : {}),
  })));
  entries.push(...bundle.omittedSources.flatMap((source) => source.sourceIds.map((sourceId) => ({
    entityId: sourceId,
    entityKind: "instruction" as const,
    provider,
    digest: source.bodyHash,
    route: "uncovered" as const,
    fidelity: "degraded" as const,
    refreshState: "degraded" as const,
    covered: false,
    evidence: [{ kind: "fallback" as const, detail: "Instruction omitted by enrollment budget." }],
    warning: "Instruction was omitted by the enrollment budget.",
  }))));

  for (const server of projection.servers) {
    entries.push({
      entityId: `mcp-server:${server.canonicalId}`,
      entityKind: "mcp-server",
      provider,
      digest: server.digest,
      route: server.route,
      fidelity: "exact",
      refreshState: "filesystem-current",
      covered: true,
      capabilities: server.capabilities,
      evidence: [{
        kind: "file-hash",
        detail: server.route === "cli-native-mcp" ? "Direct native MCP entry" : "Named stdio proxy entry",
        digest: server.digest,
      }],
      ...(server.warnings.length > 0 ? { warning: server.warnings.join(" ") } : {}),
    });

    for (const capability of server.capabilities.filter((value) => value !== "unknown-until-connect")) {
      const entityKind =
        capability === "tools" ? "mcp-tools" as const
          : capability === "resources" ? "mcp-resources" as const
            : capability === "prompts" ? "mcp-prompts" as const
              : capability === "tasks" ? "mcp-tasks" as const
                : "mcp-initialization-instructions" as const;
      entries.push({
        entityId: `mcp-${capability}:${server.canonicalId}`,
        entityKind,
        provider,
        digest: server.digest,
        route: server.route,
        fidelity: "exact",
        refreshState: "filesystem-current",
        covered: true,
        capabilities: [capability],
        evidence: [{ kind: "provider-probe", detail: `Canonical discovery advertises ${capability}.` }],
      });
    }
  }
  return entries;
};

const redactArgumentValues = (args: readonly string[]): string[] => {
  return args.map((arg, index) => {
    if (arg.startsWith("--") || index === 0) return arg.split("=")[0] ?? arg;
    return "<value>";
  });
};

export const materializeCliEnrollment = async (
  params: MaterializeCliEnrollmentParams,
): Promise<MaterializedCliEnrollment> => {
  await cleanupStaleEnrollmentArtifacts();
  const rootPath = await mkdtemp(join(tmpdir(), SESSION_ROOT_PREFIX));
  await chmod(rootPath, 0o700).catch(() => undefined);

  try {
    const [probe, projection] = await Promise.all([
      probeProviderCli(params.provider, params.executable),
      projectMcpForProvider(params.provider, params.workspaceRoot),
    ]);
    const instructionBundle = compileInstructionBundle(
      params.taskContext,
      params.additionalSystemPromptSections ?? [],
    );
    const nativeSources = await scanNativeInstructionSources(
      params.provider,
      params.workspaceRoot,
      instructionBundle,
    );
    const adoptedSourceIds = new Set(
      nativeSources.flatMap((finding) =>
        finding.policy === "adopted" && finding.sourceId
          ? [finding.sourceId]
          : [],
      ),
    );
    const deliveryText = renderCompiledInstructionSources(
      instructionBundle.sources.filter((source) => !adoptedSourceIds.has(source.id)),
    );
    const rendered = await renderEnrollment(
      params.provider,
      rootPath,
      deliveryText,
      projection,
      params.codexInstructionFallback === true,
    );
    const coverage = createCoverage(
      params.provider,
      "cli-native-instruction",
      instructionBundle,
      projection,
      adoptedSourceIds,
      nativeSources.some((finding) => finding.policy === "allowed"),
    );
    const coverageSummary = summarizeEnrollmentCoverage(coverage);
    const manifestPath = join(rootPath, "enrollment-manifest.json");
    const manifest: EnrollmentManifest = {
      schemaVersion: PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION,
      runId: params.runId,
      provider: params.provider,
      ...(probe.version ? { providerVersion: probe.version } : {}),
      workspaceId: sha256(params.workspaceRoot).slice(0, 20),
      audience: instructionBundle.audience,
      createdAt: new Date().toISOString(),
      instructionBundle: {
        digest: instructionBundle.digest,
        estimatedTokens: instructionBundle.estimatedTokens,
        truncated: instructionBundle.truncated,
        sources: instructionBundle.sources.map((source) => ({
          id: source.id,
          name: source.name,
          ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
          bodyHash: source.bodyHash,
          sourceIds: source.sourceIds,
        })),
        omittedSources: instructionBundle.omittedSources,
      },
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
      nativeSources: nativeSources.map((finding) => ({
        path: finding.path,
        digest: finding.digest,
        policy: finding.policy,
      })),
      arguments: redactArgumentValues(rendered.args),
      environmentKeys: Object.keys(rendered.env).sort(),
      coverage,
      coverageSummary,
      warnings: [
        ...instructionBundle.warnings,
        ...projection.warnings,
        ...probe.warnings,
        ...(params.codexInstructionFallback
          ? ["Codex developer_instructions was unavailable; using the isolated-home AGENTS fallback."]
          : []),
        ...nativeSources
          .filter((finding) => finding.policy === "allowed")
          .map((finding) =>
            `Provider-native instruction ${finding.path} remains enabled in addition to the canonical Machdoch bundle.`,
          ),
      ],
    };
    await writeJsonAtomically(manifestPath, manifest);
    await chmod(manifestPath, 0o600).catch(() => undefined);

    return {
      provider: params.provider,
      rootPath,
      instructionBundle,
      instructionRoute: "cli-native-instruction",
      mcpProjection: projection,
      args: rendered.args,
      env: rendered.env,
      manifest,
      manifestPath,
      dispose: async (): Promise<void> => {
        await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};
