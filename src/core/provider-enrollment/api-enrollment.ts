import type { ProviderSurface } from "./types.js";
import type { TaskExecutionSection } from "../types.js";
import {
  listEnabledMcpServers,
  loadMcpConfig,
  loadMcpDiscoveryCacheSync,
} from "../mcp/config.js";
import { digestJson, sha256 } from "./digests.js";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import type {
  CompiledInstructionBundle,
  EnrollmentCoverageEntry,
  EnrollmentCoverageSummary,
} from "./types.js";

export interface ApiEnrollmentSnapshot {
  provider: ProviderSurface;
  bundleDigest: string;
  coverage: EnrollmentCoverageEntry[];
  coverageSummary: EnrollmentCoverageSummary;
}

export const loadMcpInitializationInstructionSections = async (
  workspaceRoot: string,
): Promise<string[]> => {
  const config = await loadMcpConfig(workspaceRoot);
  const discovery = loadMcpDiscoveryCacheSync(workspaceRoot).servers;
  const byDigest = new Map<string, { serverIds: string[]; body: string }>();
  for (const server of listEnabledMcpServers(config)) {
    const body = discovery[server.id]?.instructions?.trim();
    if (!body) continue;
    const digest = sha256(body);
    const existing = byDigest.get(digest);
    if (existing) {
      existing.serverIds.push(server.id);
    } else {
      byDigest.set(digest, { serverIds: [server.id], body });
    }
  }
  return [...byDigest.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([digest, entry]) => [
      `<mcp_server_initialization_instruction server_ids=${JSON.stringify(entry.serverIds.sort().join(","))} digest="${digest}">`,
      entry.body,
      "</mcp_server_initialization_instruction>",
    ].join("\n"));
};

export const createApiEnrollmentSnapshot = async (
  provider: ProviderSurface,
  bundle: CompiledInstructionBundle,
  workspaceRoot: string,
): Promise<ApiEnrollmentSnapshot> => {
  const degradedSourceIds = new Set(bundle.degradedSourceIds);
  const coverage: EnrollmentCoverageEntry[] = bundle.sources.flatMap((source) => source.sourceIds.map((sourceId) => ({
    entityId: sourceId,
    entityKind: "instruction",
    provider,
    digest: source.bodyHash,
    route: degradedSourceIds.has(source.id) ? "uncovered" : "api-request",
    fidelity: degradedSourceIds.has(source.id) ? "degraded" : "exact",
    refreshState: degradedSourceIds.has(source.id) ? "degraded" : "request-current",
    covered: !degradedSourceIds.has(source.id),
    evidence: [{
      kind: "request-field",
      detail:
        provider === "openai"
          ? "Responses API instructions"
          : provider === "anthropic"
            ? "Messages API system"
            : provider === "google"
              ? "Gemini systemInstruction"
              : "First system message",
      digest: bundle.digest,
    }],
    ...(degradedSourceIds.has(source.id)
      ? { warning: "Instruction content was truncated by the enrollment budget." }
      : {}),
  })));
  coverage.push(...bundle.omittedSources.flatMap((source) => source.sourceIds.map((sourceId) => ({
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
  const mcpConfig = await loadMcpConfig(workspaceRoot);
  const discovery = loadMcpDiscoveryCacheSync(workspaceRoot).servers;
  for (const server of listEnabledMcpServers(mcpConfig)) {
    const capabilities = discovery[server.id]
      ? [
          ...(discovery[server.id]?.tools.length ? ["tools"] : []),
          ...(discovery[server.id]?.resources.length || discovery[server.id]?.resourceTemplates.length ? ["resources"] : []),
          ...(discovery[server.id]?.prompts.length ? ["prompts"] : []),
          ...(discovery[server.id]?.instructions ? ["initialization-instructions"] : []),
          ...(discovery[server.id]?.capabilities && "tasks" in (discovery[server.id]?.capabilities ?? {}) ? ["tasks"] : []),
        ]
      : ["unknown-until-connect"];
    const digest = digestJson({ server, discovery: discovery[server.id] });
    const evidence = [{
      kind: "request-field" as const,
      detail: "Machdoch MCP manager is exposed through direct/meta model tools.",
    }];
    coverage.push({
      entityId: `mcp-server:${server.id}`,
      entityKind: "mcp-server",
      provider,
      digest,
      route: "application-mcp",
      fidelity: "exact",
      refreshState: "request-current",
      covered: true,
      capabilities,
      evidence,
    });
    for (const capability of capabilities.filter((value) => value !== "unknown-until-connect")) {
      coverage.push({
        entityId: `mcp-${capability}:${server.id}`,
        entityKind:
          capability === "tools" ? "mcp-tools"
            : capability === "resources" ? "mcp-resources"
              : capability === "prompts" ? "mcp-prompts"
                : capability === "tasks" ? "mcp-tasks"
                  : "mcp-initialization-instructions",
        provider,
        digest,
        route: "application-mcp",
        fidelity: "exact",
        refreshState: "request-current",
        covered: true,
        capabilities: [capability],
        evidence,
      });
    }
  }
  return {
    provider,
    bundleDigest: bundle.digest,
    coverage,
    coverageSummary: summarizeEnrollmentCoverage(coverage),
  };
};

export const createApiEnrollmentSection = (
  snapshot: ApiEnrollmentSnapshot,
): TaskExecutionSection => ({
  title: "Provider enrollment",
  lines: [
    `provider: ${snapshot.provider}`,
    "instruction route: request-native system/developer field",
    "MCP route: Machdoch application-managed direct/meta tools",
    `bundle digest: ${snapshot.bundleDigest}`,
    `coverage: ${snapshot.coverageSummary.covered}/${snapshot.coverageSummary.total}`,
    ...snapshot.coverage.map(
      (entry) => `${entry.entityId}: ${entry.route} ${entry.fidelity}`,
    ),
  ],
});
