import type {
  AgentCliProvider,
  ConfiguredModelProvider,
} from "../runtime-contract.generated.js";
import type { InstructionTargetAudience } from "../types.js";

export const PROVIDER_ENROLLMENT_SCHEMA_VERSION = 1;
export const PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION = 1;

export type ProviderSurface = ConfiguredModelProvider;
export type EnrollmentFidelity = "exact" | "equivalent" | "baseline" | "degraded";
export type EnrollmentRefreshState =
  | "request-current"
  | "filesystem-current"
  | "awaiting-provider-refresh"
  | "provider-current"
  | "degraded";
export type EnrollmentDeliveryRoute =
  | "api-request"
  | "application-mcp"
  | "cli-native-instruction"
  | "cli-prompt-fallback"
  | "cli-native-mcp"
  | "cli-stdio-proxy"
  | "cli-aggregate-broker"
  | "provider-native-adopted"
  | "uncovered";
export type EnrollmentEntityKind =
  | "instruction"
  | "mcp-server"
  | "mcp-tools"
  | "mcp-resources"
  | "mcp-prompts"
  | "mcp-tasks"
  | "mcp-initialization-instructions";

export interface CompiledInstructionSource {
  id: string;
  name: string;
  sourcePath?: string;
  bodyHash: string;
  sourceIds: string[];
  priority: number;
  body: string;
}

export interface CompiledInstructionBundle {
  schemaVersion: typeof PROVIDER_ENROLLMENT_SCHEMA_VERSION;
  audience: InstructionTargetAudience;
  sources: CompiledInstructionSource[];
  omittedSources: Array<Pick<
    CompiledInstructionSource,
    "id" | "name" | "sourcePath" | "bodyHash" | "sourceIds"
  >>;
  degradedSourceIds: string[];
  renderedText: string;
  digest: string;
  estimatedTokens: number;
  truncated: boolean;
  warnings: string[];
}

export interface EnrollmentEvidence {
  kind:
    | "request-field"
    | "argument"
    | "environment"
    | "file-hash"
    | "provider-probe"
    | "fallback";
  detail: string;
  digest?: string;
}

export interface EnrollmentCoverageEntry {
  entityId: string;
  entityKind: EnrollmentEntityKind;
  provider: ProviderSurface;
  digest: string;
  route: EnrollmentDeliveryRoute;
  fidelity: EnrollmentFidelity;
  refreshState: EnrollmentRefreshState;
  covered: boolean;
  capabilities?: string[];
  evidence: EnrollmentEvidence[];
  warning?: string;
}

export interface EnrollmentCoverageSummary {
  total: number;
  covered: number;
  uncovered: number;
  complete: boolean;
  uncoveredEntityIds: string[];
  routes: Partial<Record<EnrollmentDeliveryRoute, number>>;
}

export interface McpProjectedServer {
  id: string;
  canonicalId: string;
  digest: string;
  route:
    | "cli-native-mcp"
    | "cli-stdio-proxy"
    | "cli-aggregate-broker";
  providerConfig: Record<string, unknown>;
  capabilities: string[];
  warnings: string[];
}

export interface McpProjection {
  provider: AgentCliProvider;
  effectiveConfigDigest: string;
  catalogDigest: string;
  servers: McpProjectedServer[];
  config: Record<string, unknown>;
  warnings: string[];
}

export interface ProviderCapabilityProfile {
  provider: ProviderSurface;
  instructionAuthority: "system" | "developer" | "native-file" | "prompt";
  instructionMechanism: string;
  mcpMechanism: "application-managed" | "native-config" | "unavailable";
  supportedMcpTransports: readonly ("stdio" | "streamable-http" | "sse")[];
  supportsPerServerProxy: boolean;
  refreshBoundary: "request" | "invocation" | "next-session";
}

export interface ProviderProbeResult {
  provider: AgentCliProvider;
  executable: string;
  available: boolean;
  version?: string;
  features: string[];
  warnings: string[];
}

export interface EnrollmentManifest {
  schemaVersion: typeof PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION;
  runId: string;
  provider: ProviderSurface;
  providerVersion?: string;
  workspaceId: string;
  audience: InstructionTargetAudience;
  createdAt: string;
  instructionBundle: {
    digest: string;
    estimatedTokens: number;
    truncated: boolean;
    sources: Array<{
      id: string;
      name: string;
      sourcePath?: string;
      bodyHash: string;
      sourceIds: string[];
    }>;
    omittedSources: Array<{
      id: string;
      name: string;
      sourcePath?: string;
      bodyHash: string;
      sourceIds: string[];
    }>;
  };
  mcp?: {
    effectiveConfigDigest: string;
    catalogDigest: string;
    servers: Array<{
      id: string;
      canonicalId: string;
      digest: string;
      route: McpProjectedServer["route"];
      capabilities: string[];
    }>;
  };
  renderedFiles: Array<{ path: string; digest: string; purpose: string }>;
  nativeSources: Array<{
    path: string;
    digest: string;
    policy: "adopted" | "allowed";
  }>;
  arguments: string[];
  environmentKeys: string[];
  coverage: EnrollmentCoverageEntry[];
  coverageSummary: EnrollmentCoverageSummary;
  warnings: string[];
}

export interface MaterializedCliEnrollment {
  provider: AgentCliProvider;
  rootPath: string;
  instructionBundle: CompiledInstructionBundle;
  instructionRoute:
    | "cli-native-instruction"
    | "cli-prompt-fallback";
  mcpProjection: McpProjection;
  args: string[];
  env: NodeJS.ProcessEnv;
  promptFallback?: string;
  manifest: EnrollmentManifest;
  manifestPath: string;
  dispose(): Promise<void>;
}

export interface ProviderEnrollmentInstructionsConfig {
  mode: "native-when-available";
  unmanagedNative: "adopt" | "allow" | "fail";
  strictConflicts: boolean;
  fallback: "automatic";
  failOnTruncation: boolean;
}

export interface ProviderEnrollmentMcpConfig {
  mode: "direct-native";
  fallback: "per-server-stdio-proxy";
  compatibilityServerName: string;
  unmanagedNative: "adopt" | "allow" | "fail";
  approvals: "never";
  progressiveDiscoveryThresholdPercent: number;
}

export interface ProviderEnrollmentPersistentSyncConfig {
  enabled: boolean;
  watch: boolean;
  daemonAtLogin: boolean;
  debounceMs: number;
  filesystemConvergenceTargetMs: number;
  fullRescanIntervalMs: number;
  autoReloadOwnedSessions: boolean;
}

export interface ProviderEnrollmentConfig {
  schemaVersion: typeof PROVIDER_ENROLLMENT_SCHEMA_VERSION;
  enabled: boolean;
  instructions: ProviderEnrollmentInstructionsConfig;
  mcp: ProviderEnrollmentMcpConfig;
  persistentSync: ProviderEnrollmentPersistentSyncConfig;
  providers: Record<AgentCliProvider, { enabled: boolean }>;
}

export type ProviderSyncTargetState =
  | "unseen"
  | "not-installed"
  | "planning"
  | "writing"
  | "filesystem-current"
  | "awaiting-provider-refresh"
  | "provider-current"
  | "degraded";

export interface ProviderSyncTargetStatus {
  provider: AgentCliProvider;
  scope: "user" | "workspace";
  state: ProviderSyncTargetState;
  targetPaths: string[];
  bundleDigest?: string;
  updatedAt: string;
  warnings: string[];
  error?: string;
}

export interface ProviderSyncStatus {
  schemaVersion: typeof PROVIDER_ENROLLMENT_SCHEMA_VERSION;
  enabled: boolean;
  daemon: {
    running: boolean;
    pid?: number;
    autostartInstalled: boolean;
    autostartPath?: string;
  };
  workspaceRoot: string;
  lastReconciledAt?: string;
  targets: ProviderSyncTargetStatus[];
}
