import type { ProviderSurface } from "./types.js";
import type { TaskExecutionSection } from "../types.js";
import type {
  FrozenInstructionSet,
  InstructionDeliveryPlan,
} from "../instruction-system/types.js";
import {
  listEnabledMcpServers,
  loadMcpConfig,
  loadMcpDiscoveryCache,
} from "../mcp/config.js";
import {
  loadMcpInitializationInstructionSnapshot,
  mcpInitializationInstructionSnapshotDigest,
  renderMcpInitializationInstructionSections,
} from "../mcp/initialization-instructions.js";
import { digestJson } from "./digests.js";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import type {
  EnrollmentCoverageEntry,
  EnrollmentCoverageSummary,
} from "./types.js";

export interface ApiEnrollmentSnapshot {
  provider: ProviderSurface;
  resolutionId: string;
  planId: string;
  canonicalDigest: string;
  environmentDigest: string;
  instructionRoute: string;
  coverage: EnrollmentCoverageEntry[];
  coverageSummary: EnrollmentCoverageSummary;
}

export const loadMcpInitializationInstructionSections = async (
  workspaceRoot: string,
): Promise<string[]> =>
  renderMcpInitializationInstructionSections(
    await loadMcpInitializationInstructionSnapshot(workspaceRoot),
  );

export const createApiEnrollmentSnapshot = async (
  provider: ProviderSurface,
  resolution: FrozenInstructionSet,
  plan: InstructionDeliveryPlan,
  workspaceRoot: string,
): Promise<ApiEnrollmentSnapshot> => {
  if (
    resolution.surface !== "api" ||
    resolution.providerId !== provider ||
    plan.resolutionId !== resolution.resolutionId ||
    plan.canonicalDigest !== resolution.canonicalDigest ||
    plan.environmentDigest !== resolution.environmentDigest ||
    plan.providerId !== resolution.providerId ||
    plan.surface !== resolution.surface ||
    plan.grade === "unsupported" ||
    plan.blockingReasons.length > 0
  ) {
    throw new Error(
      "API enrollment requires a matching, deliverable frozen instruction plan.",
    );
  }
  const currentMcpInitializationInstructions =
    await loadMcpInitializationInstructionSnapshot(workspaceRoot);
  if (
    mcpInitializationInstructionSnapshotDigest(
      currentMcpInitializationInstructions,
    ) !==
    mcpInitializationInstructionSnapshotDigest(
      resolution.mcpInitializationInstructions,
    )
  ) {
    throw new Error(
      "MCP initialization instructions changed after instruction-plan review. Refresh resolution before provider launch.",
    );
  }
  const coverage: EnrollmentCoverageEntry[] = [];
  const mcpConfig = await loadMcpConfig(workspaceRoot);
  const discovery = (await loadMcpDiscoveryCache(workspaceRoot)).servers;
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
    resolutionId: resolution.resolutionId,
    planId: plan.planId,
    canonicalDigest: resolution.canonicalDigest,
    environmentDigest: resolution.environmentDigest,
    instructionRoute: plan.route,
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
    `instruction route: ${snapshot.instructionRoute}`,
    "MCP route: Machdoch application-managed direct/meta tools",
    `instruction resolution: ${snapshot.resolutionId}`,
    `instruction plan: ${snapshot.planId}`,
    `canonical digest: ${snapshot.canonicalDigest}`,
    `environment digest: ${snapshot.environmentDigest}`,
    `MCP coverage: ${snapshot.coverageSummary.covered}/${snapshot.coverageSummary.total}`,
    ...snapshot.coverage.map(
      (entry) => `${entry.entityId}: ${entry.route} ${entry.fidelity}`,
    ),
  ],
});
