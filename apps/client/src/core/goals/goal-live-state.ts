import type { AgentLiveState } from "../types.js";

const MAX_LIMITS = 8;
const MAX_FILE_CHANGES = 200;
const MAX_TASKS = 60;

const sumCounts = <Key extends string>(
  keys: readonly Key[],
  left: Partial<Record<Key, number | undefined>> | undefined,
  right: Partial<Record<Key, number | undefined>> | undefined,
): Partial<Record<Key, number>> => {
  const sums: Partial<Record<Key, number>> = {};
  for (const key of keys) {
    const leftCount = left?.[key];
    const rightCount = right?.[key];
    if (leftCount !== undefined || rightCount !== undefined)
      sums[key] = (leftCount ?? 0) + (rightCount ?? 0);
  }
  return sums;
};

const mergeById = <Item>(
  earlier: readonly Item[] | undefined,
  later: readonly Item[] | undefined,
  idOf: (item: Item) => string,
  merge: (previous: Item, next: Item) => Item,
): Item[] => {
  const merged = new Map((earlier ?? []).map((item) => [idOf(item), item]));
  for (const item of later ?? []) {
    const previous = merged.get(idOf(item));
    merged.set(idOf(item), previous ? merge(previous, item) : item);
  }
  return [...merged.values()];
};

/**
 * Each goal turn starts a new provider process that reports only its own work.
 * Adds what earlier turns reported, so the run shows the goal as a whole.
 */
export const combineGoalTurnLive = (
  earlier: AgentLiveState | undefined,
  turn: AgentLiveState,
): AgentLiveState => {
  if (!earlier) return turn;
  const usage = {
    ...earlier.usage,
    ...turn.usage,
    ...sumCounts(
      ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costUsd"],
      earlier.usage,
      turn.usage,
    ),
  };
  const limits = mergeById(
    earlier.limits,
    turn.limits,
    (limit) => limit.id,
    (_previous, next) => next,
  ).slice(-MAX_LIMITS);
  const fileChanges = mergeById(
    earlier.fileChanges,
    turn.fileChanges,
    (change) => change.path,
    (previous, next) => ({
      ...next,
      ...sumCounts(["additions", "deletions"], previous, next),
    }),
  ).slice(-MAX_FILE_CHANGES);
  const tasks = mergeById(
    earlier.tasks?.map((task) =>
      task.status === "running"
        ? { ...task, status: "stopped" as const, canStop: false }
        : task,
    ),
    turn.tasks,
    (task) => task.id,
    (_previous, next) => next,
  ).slice(-MAX_TASKS);
  const plan = turn.plan ?? earlier.plan;
  return {
    ...turn,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(limits.length > 0 ? { limits } : {}),
    ...(fileChanges.length > 0 ? { fileChanges } : {}),
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(plan ? { plan } : {}),
  };
};
