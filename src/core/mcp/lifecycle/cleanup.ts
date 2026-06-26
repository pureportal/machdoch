import { isManagedMcpId } from "./ids.js";
import {
  loadMcpLifecycleState,
  runMcpLifecycleMutation,
  saveMcpLifecycleState,
} from "./store.js";
import {
  DEFAULT_NEVER_USED_DAYS,
  DEFAULT_UNUSED_DAYS,
  type McpLifecycleCleanupApplyResult,
  type McpLifecycleCleanupCandidate,
  type McpLifecycleCleanupPlan,
  type McpLifecycleCleanupPolicy,
  type McpLifecycleRecord,
  type McpLifecycleStoreOptions,
} from "./schema.js";
import { ageDays, getDateOrNow, latestIso } from "./utils.js";

const getLastUsedAt = (record: McpLifecycleRecord): string | undefined => {
  return latestIso([
    record.lastObservedAt,
    record.lastInvokedAt,
    record.lastCacheHitAt,
    record.lastRemoteExecutedAt,
    record.lastSucceededAt,
    record.lastFailedAt,
  ]);
};

const isCleanupEligible = (record: McpLifecycleRecord): boolean => {
  return (
    isManagedMcpId(record.managedId) &&
    record.protected !== true &&
    record.state !== "removed" &&
    record.state !== "pending-removal"
  );
};

const createCleanupCandidate = (
  record: McpLifecycleRecord,
  now: Date,
  unusedDays: number,
  neverUsedDays: number,
): McpLifecycleCleanupCandidate | undefined => {
  const lastUsedAt = getLastUsedAt(record);
  const comparisonTimestamp = lastUsedAt ?? record.addedAt;
  const thresholdDays = lastUsedAt ? unusedDays : neverUsedDays;
  const currentAgeDays = ageDays(now, comparisonTimestamp);

  if (currentAgeDays < thresholdDays) {
    return undefined;
  }

  const reason = lastUsedAt
    ? `unused for ${currentAgeDays} days`
    : `never used for ${currentAgeDays} days`;

  return {
    managedId: record.managedId,
    ...(record.sourceServerId ? { sourceServerId: record.sourceServerId } : {}),
    agent: record.agent,
    state: record.state,
    ageDays: currentAgeDays,
    thresholdDays,
    reason,
    recommendedAction: "mark-stale",
    ...(lastUsedAt ? { lastUsedAt } : {}),
    addedAt: record.addedAt,
  };
};

export const createMcpLifecycleCleanupPlan = async (
  policy: McpLifecycleCleanupPolicy = {},
  options: McpLifecycleStoreOptions = {},
): Promise<McpLifecycleCleanupPlan> => {
  const unusedDays = policy.unusedDays ?? DEFAULT_UNUSED_DAYS;
  const neverUsedDays = policy.neverUsedDays ?? DEFAULT_NEVER_USED_DAYS;
  const now = getDateOrNow(policy.now);
  const state = await loadMcpLifecycleState(options);
  const candidates = Object.values(state.records)
    .filter(isCleanupEligible)
    .flatMap((record) => {
      const candidate = createCleanupCandidate(
        record,
        now,
        unusedDays,
        neverUsedDays,
      );

      return candidate ? [candidate] : [];
    })
    .sort((left, right) => {
      return (
        right.ageDays - left.ageDays ||
        left.managedId.localeCompare(right.managedId)
      );
    });

  return {
    generatedAt: now.toISOString(),
    policy: {
      unusedDays,
      neverUsedDays,
    },
    candidates,
  };
};

export const applyMcpLifecycleCleanupPlan = async (
  plan: McpLifecycleCleanupPlan,
  options: McpLifecycleStoreOptions = {},
): Promise<McpLifecycleCleanupApplyResult> => {
  return runMcpLifecycleMutation(options, async () => {
    const state = await loadMcpLifecycleState(options);
    const managedIds: string[] = [];

    for (const candidate of plan.candidates) {
      const record = state.records[candidate.managedId];

      if (!record || !isCleanupEligible(record)) {
        continue;
      }

      if ((getLastUsedAt(record) ?? undefined) !== candidate.lastUsedAt) {
        continue;
      }

      record.state = "stale-candidate";
      record.updatedAt = plan.generatedAt;
      record.cleanup = {
        candidateSince: record.cleanup?.candidateSince ?? plan.generatedAt,
        lastEvaluatedAt: plan.generatedAt,
        reason: candidate.reason,
        thresholdDays: candidate.thresholdDays,
      };
      managedIds.push(record.managedId);
    }

    state.updatedAt = plan.generatedAt;
    const statePath = await saveMcpLifecycleState(state, options);

    return {
      statePath,
      updatedAt: plan.generatedAt,
      markedCount: managedIds.length,
      managedIds,
    };
  });
};
