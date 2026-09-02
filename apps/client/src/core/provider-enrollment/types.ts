import type {
  AgentCliProvider,
  ConfiguredModelProvider,
} from "../runtime-contract.generated.js";
import type {
  InstructionDeliveryDimension,
  InstructionDeliveryGrade,
  NativeInstructionRecord,
  ResolvedInstructionSource,
} from "../instruction-system/types.js";

export const PROVIDER_ENROLLMENT_SCHEMA_VERSION = 1;
export const PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION = 2;

export type EnrollmentRenderedFileRole =
  | "instruction-transport"
  | "mcp-configuration"
  | "instruction-and-mcp-configuration";

export type ProviderSurface = ConfiguredModelProvider;
export type EnrollmentFidelity =
  | "exact"
  | "equivalent"
  | "baseline"
  | "degraded";
export type EnrollmentRefreshState =
  | "request-current"
  | "filesystem-current"
  | "awaiting-provider-refresh"
  | "provider-current"
  | "degraded";
export type EnrollmentDeliveryRoute =
  | "application-mcp"
  | "cli-native-mcp"
  | "cli-stdio-proxy"
  | "cli-aggregate-broker"
  | "uncovered";
export type EnrollmentEntityKind =
  | "mcp-server"
  | "mcp-tools"
  | "mcp-resources"
  | "mcp-prompts"
  | "mcp-tasks"
  | "mcp-initialization-instructions";

export interface EnrollmentEvidence {
  kind:
    | "request-field"
    | "argument"
    | "environment"
    | "file-hash"
    | "provider-probe";
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
  route: "cli-native-mcp" | "cli-stdio-proxy" | "cli-aggregate-broker";
  providerConfig: Record<string, unknown>;
  capabilities: string[];
  warnings: string[];
}

export interface McpUncoveredServer {
  canonicalId: string;
  digest: string;
  capabilities: string[];
  reason: string;
}

export interface McpProjection {
  provider: AgentCliProvider;
  effectiveConfigDigest: string;
  catalogDigest: string;
  servers: McpProjectedServer[];
  uncoveredServers: McpUncoveredServer[];
  config: Record<string, unknown>;
  environment: Record<string, string>;
  warnings: string[];
}

export interface ProviderCapabilityProfile {
  provider: ProviderSurface;
  instructionAuthority: "system" | "developer" | "native-file";
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

export interface MaterializedInstructionDelivery {
  resolutionId: string;
  planId: string;
  canonicalDigest: string;
  environmentDigest: string;
  grade: InstructionDeliveryGrade;
  planRoute: string;
  transportRoute:
    | "codex-developer-config"
    | "claude-system-prompt-file"
    | "copilot-custom-agent";
  envelopeBytes: number;
  instructionPayloadBytes: number;
  instructionPayloadIncludedInRequest: boolean;
  estimatedTokens?: number;
  truncation: "none";
  sources: Array<
    Pick<
      ResolvedInstructionSource,
      | "id"
      | "name"
      | "kind"
      | "scopePath"
      | "precedence"
      | "digest"
      | "byteLength"
      | "lineCount"
    >
  >;
  dimensions: InstructionDeliveryDimension[];
}

export interface EnrollmentManifest {
  schemaVersion: typeof PROVIDER_ENROLLMENT_MANIFEST_SCHEMA_VERSION;
  runId: string;
  provider: ProviderSurface;
  providerVersion?: string;
  providerFeatures: string[];
  providerProbeDigest: string;
  workspaceId: string;
  createdAt: string;
  instructionDelivery: MaterializedInstructionDelivery;
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
  renderedFiles: Array<{
    path: string;
    digest: string;
    role: EnrollmentRenderedFileRole;
    purpose: string;
  }>;
  nativeSources: Array<{
    path: string;
    location: NativeInstructionRecord["location"];
    convention: NativeInstructionRecord["convention"];
    status: NativeInstructionRecord["status"];
    digest?: string;
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
  instructionDelivery: MaterializedInstructionDelivery;
  instructionRoute: MaterializedInstructionDelivery["transportRoute"];
  mcpProjection: McpProjection;
  args: string[];
  env: NodeJS.ProcessEnv;
  manifest: EnrollmentManifest;
  manifestPath: string;
  dispose(): Promise<EnrollmentDisposalResult>;
}

export interface EnrollmentDisposalResult {
  status: "removed" | "deferred";
  errorCode?: string;
}

export interface ProviderEnrollmentMcpConfig {
  unmanagedNative: "adopt" | "allow" | "fail";
  approvals: "never";
}

export interface ProviderEnrollmentPersistentSyncConfig {
  enabled: boolean;
  watch: boolean;
  daemonAtLogin: boolean;
  debounceMs: number;
  fullRescanIntervalMs: number;
}

export interface ProviderEnrollmentConfig {
  schemaVersion: typeof PROVIDER_ENROLLMENT_SCHEMA_VERSION;
  enabled: boolean;
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
