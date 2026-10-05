import type { RalphFlow } from "../ralph.js";
import { parseRalphWorkItemState } from "./transition-ralph-work-item-state.helper.js";

export const resolveRalphDeferredTaskResumeBlock = (
  tasks: readonly Record<string, unknown>[],
  blocks: RalphFlow["blocks"],
  runId: string,
): string | undefined => {
  const resumeBlocks = new Set<string>();
  for (const task of tasks) {
    if (task.status !== "deferred") continue;
    const history = Array.isArray(task.stateHistory) ? task.stateHistory : [];
    const deferred = history.at(-1) as Record<string, unknown> | undefined;
    const phase = parseRalphWorkItemState(deferred?.from);
    if (
      task.runId !== runId ||
      deferred?.runId !== runId ||
      deferred.to !== "deferred" ||
      !["implementing", "verifying", "repairing"].includes(phase ?? "")
    ) {
      throw new Error(
        "Deferred selected work has no recoverable phase owned by this run.",
      );
    }
    const phaseEntry = [...history]
      .reverse()
      .find(
        (entry: Record<string, unknown>) =>
          entry.to === phase && entry.runId === runId,
      ) as Record<string, unknown> | undefined;
    const block = blocks.find(
      (candidate) => candidate.id === phaseEntry?.blockId,
    );
    if (
      block?.type !== "UTILITY" ||
      !(
        (block.utility.type === "MARK_JSON_TASK" &&
          block.utility.status === phase) ||
        (block.utility.type === "SELECT_JSON_TASK" && phase === "implementing")
      )
    ) {
      throw new Error(
        "Deferred selected work cannot restore its phase in the pinned flow.",
      );
    }
    resumeBlocks.add(block.id);
  }
  if (resumeBlocks.size > 1) {
    throw new Error(
      "Deferred selected work requires different recovery phases.",
    );
  }
  return [...resumeBlocks][0];
};
