import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "../../env.js";
import { withCooperativeFileLock } from "../../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../../_helpers/write-file-atomically.helper.js";
import { createManagedMcpId, getSourceServerIdFromManagedId } from "./ids.js";
import {
  MCP_LIFECYCLE_FILE_NAME,
  MCP_LIFECYCLE_OPERATIONS,
  MCP_LIFECYCLE_SCHEMA_VERSION,
  normalizeLifecycleState,
  normalizeMcpLifecycleAgent,
  type McpLifecycleOperation,
  type McpLifecycleOperationUsage,
  type McpLifecycleRecord,
  type McpLifecycleState,
  type McpLifecycleStoreOptions,
} from "./schema.js";
import {
  isRecord,
  normalizeIsoTimestamp,
  normalizeOptionalIsoTimestamp,
  optionalNumber,
  optionalString,
} from "./utils.js";

const lifecycleMutationQueues = new Map<string, Promise<unknown>>();

export const getUserMcpLifecyclePath = (): string => {
  return join(dirname(getUserConfigPath()), MCP_LIFECYCLE_FILE_NAME);
};

export const getMcpLifecycleStatePath = (
  options: McpLifecycleStoreOptions = {},
): string => {
  return options.statePath ?? getUserMcpLifecyclePath();
};

export const runMcpLifecycleMutation = async <T>(
  options: McpLifecycleStoreOptions,
  mutation: () => Promise<T>,
): Promise<T> => {
  const statePath = getMcpLifecycleStatePath(options);
  const previous = lifecycleMutationQueues.get(statePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => withCooperativeFileLock(statePath, mutation));
  const queued = next.catch(() => undefined).finally(() => {
    if (lifecycleMutationQueues.get(statePath) === queued) {
      lifecycleMutationQueues.delete(statePath);
    }
  });

  lifecycleMutationQueues.set(statePath, queued);

  return next;
};

const createEmptyLifecycleState = (timestamp: string): McpLifecycleState => {
  return {
    schemaVersion: MCP_LIFECYCLE_SCHEMA_VERSION,
    updatedAt: timestamp,
    records: {},
  };
};

const normalizeOperationUsage = (
  value: unknown,
  operation: McpLifecycleOperation,
  timestamp: string,
): McpLifecycleOperationUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const lastObservedAt = normalizeOptionalIsoTimestamp(
    value.lastObservedAt,
    timestamp,
  );
  const lastInvokedAt = normalizeOptionalIsoTimestamp(
    value.lastInvokedAt,
    timestamp,
  );
  const lastCacheHitAt = normalizeOptionalIsoTimestamp(
    value.lastCacheHitAt,
    timestamp,
  );
  const lastRemoteExecutedAt = normalizeOptionalIsoTimestamp(
    value.lastRemoteExecutedAt,
    timestamp,
  );
  const lastSucceededAt = normalizeOptionalIsoTimestamp(
    value.lastSucceededAt,
    timestamp,
  );
  const lastFailedAt = normalizeOptionalIsoTimestamp(
    value.lastFailedAt,
    timestamp,
  );

  return {
    operation,
    usageCount: optionalNumber(value.usageCount) ?? 0,
    eventCount: optionalNumber(value.eventCount) ?? 0,
    remoteExecutionCount: optionalNumber(value.remoteExecutionCount) ?? 0,
    cacheHitCount: optionalNumber(value.cacheHitCount) ?? 0,
    failureCount: optionalNumber(value.failureCount) ?? 0,
    ...(lastObservedAt ? { lastObservedAt } : {}),
    ...(lastInvokedAt ? { lastInvokedAt } : {}),
    ...(lastCacheHitAt ? { lastCacheHitAt } : {}),
    ...(lastRemoteExecutedAt ? { lastRemoteExecutedAt } : {}),
    ...(lastSucceededAt ? { lastSucceededAt } : {}),
    ...(lastFailedAt ? { lastFailedAt } : {}),
  };
};

const normalizeLifecycleRecord = (
  key: string,
  value: unknown,
  timestamp: string,
): McpLifecycleRecord | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const managedId = createManagedMcpId(optionalString(value.managedId) ?? key);
  const agent = normalizeMcpLifecycleAgent(optionalString(value.agent)) ?? "machdoch";
  const operations: Partial<Record<McpLifecycleOperation, McpLifecycleOperationUsage>> =
    {};

  if (isRecord(value.operations)) {
    for (const operation of MCP_LIFECYCLE_OPERATIONS) {
      const usage = normalizeOperationUsage(
        value.operations[operation],
        operation,
        timestamp,
      );

      if (usage) {
        operations[operation] = usage;
      }
    }
  }

  const addedAt = normalizeIsoTimestamp(optionalString(value.addedAt), timestamp);
  const updatedAt = normalizeIsoTimestamp(optionalString(value.updatedAt), addedAt);
  const sourceServerId =
    optionalString(value.sourceServerId) ?? getSourceServerIdFromManagedId(managedId);
  const transportType = optionalString(value.transportType);
  const scope = optionalString(value.scope);
  const workspaceRoot = optionalString(value.workspaceRoot);
  const fingerprint = optionalString(value.fingerprint);
  const remoteExecutionCount = optionalNumber(value.remoteExecutionCount);
  const cacheHitCount = optionalNumber(value.cacheHitCount);
  const failureCount = optionalNumber(value.failureCount);
  const cleanup = isRecord(value.cleanup)
    ? normalizeLifecycleCleanup(value.cleanup, timestamp)
    : undefined;

  return {
    managedId,
    ...(sourceServerId ? { sourceServerId } : {}),
    agent,
    ...(scope ? { scope } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(transportType === "stdio" ||
    transportType === "streamable-http" ||
    transportType === "sse"
      ? { transportType }
      : {}),
    state: normalizeLifecycleState(value.state),
    ...(value.protected === true ? { protected: true } : {}),
    addedAt,
    updatedAt,
    ...normalizeLifecycleTimestamps(value, timestamp),
    usageCount: optionalNumber(value.usageCount) ?? 0,
    eventCount: optionalNumber(value.eventCount) ?? 0,
    ...(remoteExecutionCount !== undefined ? { remoteExecutionCount } : {}),
    ...(cacheHitCount !== undefined ? { cacheHitCount } : {}),
    ...(failureCount !== undefined ? { failureCount } : {}),
    ...(Object.keys(operations).length > 0 ? { operations } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
};

const normalizeLifecycleTimestamps = (
  value: Record<string, unknown>,
  timestamp: string,
): Partial<
  Pick<
    McpLifecycleRecord,
    | "lastSyncedAt"
    | "lastObservedAt"
    | "lastInvokedAt"
    | "lastCacheHitAt"
    | "lastRemoteExecutedAt"
    | "lastSucceededAt"
    | "lastFailedAt"
  >
> => {
  const lastSyncedAt = normalizeOptionalIsoTimestamp(value.lastSyncedAt, timestamp);
  const lastObservedAt = normalizeOptionalIsoTimestamp(
    value.lastObservedAt,
    timestamp,
  );
  const lastInvokedAt = normalizeOptionalIsoTimestamp(value.lastInvokedAt, timestamp);
  const lastCacheHitAt = normalizeOptionalIsoTimestamp(
    value.lastCacheHitAt,
    timestamp,
  );
  const lastRemoteExecutedAt = normalizeOptionalIsoTimestamp(
    value.lastRemoteExecutedAt,
    timestamp,
  );
  const lastSucceededAt = normalizeOptionalIsoTimestamp(
    value.lastSucceededAt,
    timestamp,
  );
  const lastFailedAt = normalizeOptionalIsoTimestamp(value.lastFailedAt, timestamp);

  return {
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(lastObservedAt ? { lastObservedAt } : {}),
    ...(lastInvokedAt ? { lastInvokedAt } : {}),
    ...(lastCacheHitAt ? { lastCacheHitAt } : {}),
    ...(lastRemoteExecutedAt ? { lastRemoteExecutedAt } : {}),
    ...(lastSucceededAt ? { lastSucceededAt } : {}),
    ...(lastFailedAt ? { lastFailedAt } : {}),
  };
};

const normalizeLifecycleCleanup = (
  value: Record<string, unknown>,
  timestamp: string,
): McpLifecycleRecord["cleanup"] | undefined => {
  const candidateSince = normalizeOptionalIsoTimestamp(
    value.candidateSince,
    timestamp,
  );
  const lastEvaluatedAt = normalizeOptionalIsoTimestamp(
    value.lastEvaluatedAt,
    timestamp,
  );
  const reason = optionalString(value.reason);
  const thresholdDays = optionalNumber(value.thresholdDays);

  if (!candidateSince && !lastEvaluatedAt && !reason && thresholdDays === undefined) {
    return undefined;
  }

  return {
    ...(candidateSince ? { candidateSince } : {}),
    ...(lastEvaluatedAt ? { lastEvaluatedAt } : {}),
    ...(reason ? { reason } : {}),
    ...(thresholdDays !== undefined ? { thresholdDays } : {}),
  };
};

export const loadMcpLifecycleState = async (
  options: McpLifecycleStoreOptions = {},
): Promise<McpLifecycleState> => {
  const timestamp = new Date().toISOString();
  const statePath = getMcpLifecycleStatePath(options);

  if (!existsSync(statePath)) {
    return createEmptyLifecycleState(timestamp);
  }

  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    return createEmptyLifecycleState(timestamp);
  }

  const records: Record<string, McpLifecycleRecord> = {};

  if (isRecord(parsed.records)) {
    for (const [key, value] of Object.entries(parsed.records)) {
      const record = normalizeLifecycleRecord(key, value, timestamp);

      if (record) {
        records[record.managedId] = record;
      }
    }
  }

  return {
    schemaVersion: MCP_LIFECYCLE_SCHEMA_VERSION,
    updatedAt: normalizeIsoTimestamp(optionalString(parsed.updatedAt), timestamp),
    records,
  };
};

export const saveMcpLifecycleState = async (
  state: McpLifecycleState,
  options: McpLifecycleStoreOptions = {},
): Promise<string> => {
  const statePath = getMcpLifecycleStatePath(options);
  await writeJsonAtomically(statePath, state);

  return statePath;
};
