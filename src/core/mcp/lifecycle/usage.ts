import { createManagedMcpId, getSourceServerIdFromManagedId } from "./ids.js";
import {
  loadMcpLifecycleState,
  runMcpLifecycleMutation,
  saveMcpLifecycleState,
} from "./store.js";
import {
  type McpLifecycleOperation,
  type McpLifecycleOperationUsage,
  type McpLifecyclePhase,
  type McpLifecycleRecord,
  type McpLifecycleState,
  type McpLifecycleStoreOptions,
  type McpUsageEvent,
} from "./schema.js";
import { normalizeIsoTimestamp } from "./utils.js";

const ensureLifecycleRecord = (
  state: McpLifecycleState,
  event: McpUsageEvent,
  timestamp: string,
): McpLifecycleRecord => {
  const managedId = createManagedMcpId(event.managedId ?? event.serverId);
  const existing = state.records[managedId];
  const sourceServerId =
    event.sourceServerId ??
    existing?.sourceServerId ??
    getSourceServerIdFromManagedId(managedId) ??
    event.serverId;
  const record: McpLifecycleRecord = existing
    ? {
        ...existing,
        managedId,
        agent: existing.agent,
        updatedAt: timestamp,
        state: existing.state === "removed" ? "active" : existing.state,
        usageCount: existing.usageCount,
        eventCount: existing.eventCount + 1,
      }
    : {
        managedId,
        sourceServerId,
        agent: event.agent,
        state: "active",
        addedAt: timestamp,
        updatedAt: timestamp,
        usageCount: 0,
        eventCount: 1,
      };

  record.sourceServerId = sourceServerId;
  record.agent = existing?.agent ?? event.agent;
  if (event.workspaceRoot) {
    record.workspaceRoot = event.workspaceRoot;
  }
  if (event.transportType) {
    record.transportType = event.transportType;
  }
  record.state = "active";
  record.lastObservedAt = timestamp;
  delete record.cleanup;

  return record;
};

const ensureOperationUsage = (
  record: McpLifecycleRecord,
  operation: McpLifecycleOperation,
): McpLifecycleOperationUsage => {
  const operations = {
    ...(record.operations ?? {}),
  };
  const usage = operations[operation] ?? {
    operation,
    usageCount: 0,
    eventCount: 0,
    remoteExecutionCount: 0,
    cacheHitCount: 0,
    failureCount: 0,
  };

  operations[operation] = usage;
  record.operations = operations;

  return usage;
};

const applyUsagePhase = (
  record: McpLifecycleRecord,
  operationUsage: McpLifecycleOperationUsage,
  phase: McpLifecyclePhase,
  timestamp: string,
): void => {
  operationUsage.eventCount += 1;
  operationUsage.lastObservedAt = timestamp;

  switch (phase) {
    case "invoked":
      record.usageCount += 1;
      record.lastInvokedAt = timestamp;
      operationUsage.usageCount += 1;
      operationUsage.lastInvokedAt = timestamp;
      break;
    case "cache-hit":
      record.cacheHitCount = (record.cacheHitCount ?? 0) + 1;
      record.lastCacheHitAt = timestamp;
      operationUsage.cacheHitCount += 1;
      operationUsage.lastCacheHitAt = timestamp;
      break;
    case "remote-started":
      record.remoteExecutionCount = (record.remoteExecutionCount ?? 0) + 1;
      record.lastRemoteExecutedAt = timestamp;
      operationUsage.remoteExecutionCount += 1;
      operationUsage.lastRemoteExecutedAt = timestamp;
      break;
    case "succeeded":
      record.lastSucceededAt = timestamp;
      record.lastRemoteExecutedAt = timestamp;
      operationUsage.lastSucceededAt = timestamp;
      operationUsage.lastRemoteExecutedAt = timestamp;
      break;
    case "failed":
      record.failureCount = (record.failureCount ?? 0) + 1;
      record.lastFailedAt = timestamp;
      record.lastRemoteExecutedAt = timestamp;
      operationUsage.failureCount += 1;
      operationUsage.lastFailedAt = timestamp;
      operationUsage.lastRemoteExecutedAt = timestamp;
      break;
  }
};

export const recordMcpUsageEvent = async (
  event: McpUsageEvent,
  options: McpLifecycleStoreOptions = {},
): Promise<McpLifecycleRecord> => {
  return runMcpLifecycleMutation(options, async () => {
    const timestamp = normalizeIsoTimestamp(
      event.timestamp ?? new Date().toISOString(),
      new Date().toISOString(),
    );
    const state = await loadMcpLifecycleState(options);
    const record = ensureLifecycleRecord(state, event, timestamp);
    const operationUsage = ensureOperationUsage(record, event.operation);

    applyUsagePhase(record, operationUsage, event.phase, timestamp);

    state.records[record.managedId] = record;
    state.updatedAt = timestamp;
    await saveMcpLifecycleState(state, options);

    return record;
  });
};

export const recordMcpUsageEventSafely = async (
  event: McpUsageEvent,
  options: McpLifecycleStoreOptions = {},
): Promise<void> => {
  await recordMcpUsageEvent(event, options).catch(() => undefined);
};
