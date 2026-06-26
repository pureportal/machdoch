import type { McpTransportType } from "../types.js";

export const MCP_LIFECYCLE_SCHEMA_VERSION = 1;
export const MACHDOCH_MANAGED_MCP_PREFIX = "machdoch_";
export const MCP_LIFECYCLE_FILE_NAME = "mcp-lifecycle.json";
export const DEFAULT_UNUSED_DAYS = 60;
export const DEFAULT_NEVER_USED_DAYS = 14;

export type McpLifecycleAgent =
  | "machdoch"
  | "codex-cli"
  | "claude-cli"
  | "copilot-cli"
  | "openai-api"
  | "anthropic-api";

export type McpLifecycleOperation = "tool" | "resource" | "prompt" | "task";
export type McpLifecyclePhase =
  | "invoked"
  | "cache-hit"
  | "remote-started"
  | "succeeded"
  | "failed";
export type McpLifecycleManagedState =
  | "active"
  | "stale-candidate"
  | "disabled"
  | "pending-removal"
  | "removed"
  | "conflict";

export interface McpLifecycleOperationUsage {
  operation: McpLifecycleOperation;
  usageCount: number;
  eventCount: number;
  remoteExecutionCount: number;
  cacheHitCount: number;
  failureCount: number;
  lastObservedAt?: string;
  lastInvokedAt?: string;
  lastCacheHitAt?: string;
  lastRemoteExecutedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
}

export interface McpLifecycleCleanupState {
  candidateSince?: string;
  lastEvaluatedAt?: string;
  reason?: string;
  thresholdDays?: number;
}

export interface McpLifecycleRecord {
  managedId: string;
  sourceServerId?: string;
  agent: McpLifecycleAgent;
  scope?: string;
  workspaceRoot?: string;
  transportType?: McpTransportType;
  state: McpLifecycleManagedState;
  protected?: boolean;
  addedAt: string;
  updatedAt: string;
  lastSyncedAt?: string;
  lastObservedAt?: string;
  lastInvokedAt?: string;
  lastCacheHitAt?: string;
  lastRemoteExecutedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
  usageCount: number;
  eventCount: number;
  remoteExecutionCount?: number;
  cacheHitCount?: number;
  failureCount?: number;
  operations?: Partial<Record<McpLifecycleOperation, McpLifecycleOperationUsage>>;
  cleanup?: McpLifecycleCleanupState;
  fingerprint?: string;
}

export interface McpLifecycleState {
  schemaVersion: typeof MCP_LIFECYCLE_SCHEMA_VERSION;
  updatedAt: string;
  records: Record<string, McpLifecycleRecord>;
}

export interface McpUsageEvent {
  timestamp?: string;
  workspaceRoot?: string;
  agent: McpLifecycleAgent;
  serverId: string;
  managedId?: string;
  sourceServerId?: string;
  operation: McpLifecycleOperation;
  phase: McpLifecyclePhase;
  target?: string;
  success?: boolean;
  error?: string;
  durationMs?: number;
  toolUseId?: string;
  turnId?: string;
  sessionId?: string;
  cacheHit?: boolean;
  transportType?: McpTransportType;
}

export interface McpLifecycleStoreOptions {
  statePath?: string;
}

export interface McpLifecycleHookOptions {
  agent?: string;
  phase?: string;
  workspaceRoot?: string;
  timestamp?: string;
}

export interface McpLifecycleCleanupPolicy {
  unusedDays?: number;
  neverUsedDays?: number;
  now?: Date | string;
}

export interface McpLifecycleCleanupCandidate {
  managedId: string;
  sourceServerId?: string;
  agent: McpLifecycleAgent;
  state: McpLifecycleManagedState;
  ageDays: number;
  thresholdDays: number;
  reason: string;
  recommendedAction: "mark-stale";
  lastUsedAt?: string;
  addedAt: string;
}

export interface McpLifecycleCleanupPlan {
  generatedAt: string;
  policy: {
    unusedDays: number;
    neverUsedDays: number;
  };
  candidates: McpLifecycleCleanupCandidate[];
}

export interface McpLifecycleCleanupApplyResult {
  statePath: string;
  updatedAt: string;
  markedCount: number;
  managedIds: string[];
}

export const MCP_LIFECYCLE_AGENTS: ReadonlySet<McpLifecycleAgent> = new Set([
  "machdoch",
  "codex-cli",
  "claude-cli",
  "copilot-cli",
  "openai-api",
  "anthropic-api",
]);

export const MCP_LIFECYCLE_PHASES: ReadonlySet<McpLifecyclePhase> = new Set([
  "invoked",
  "cache-hit",
  "remote-started",
  "succeeded",
  "failed",
]);

export const MCP_LIFECYCLE_OPERATIONS: ReadonlySet<McpLifecycleOperation> =
  new Set(["tool", "resource", "prompt", "task"]);

export const normalizeMcpLifecycleAgent = (
  value: string | undefined,
): McpLifecycleAgent | undefined => {
  return value && MCP_LIFECYCLE_AGENTS.has(value as McpLifecycleAgent)
    ? (value as McpLifecycleAgent)
    : undefined;
};

export const normalizeMcpLifecyclePhase = (
  value: string | undefined,
): McpLifecyclePhase | undefined => {
  return value && MCP_LIFECYCLE_PHASES.has(value as McpLifecyclePhase)
    ? (value as McpLifecyclePhase)
    : undefined;
};

export const normalizeMcpLifecycleOperation = (
  value: string | undefined,
): McpLifecycleOperation | undefined => {
  return value && MCP_LIFECYCLE_OPERATIONS.has(value as McpLifecycleOperation)
    ? (value as McpLifecycleOperation)
    : undefined;
};

export const normalizeLifecycleState = (
  value: unknown,
): McpLifecycleManagedState => {
  switch (value) {
    case "active":
    case "stale-candidate":
    case "disabled":
    case "pending-removal":
    case "removed":
    case "conflict":
      return value;
    default:
      return "active";
  }
};
