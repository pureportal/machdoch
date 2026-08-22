import type {
  RalphFlowVariable,
  RalphRunResult,
} from "../../../../core/ralph.js";
import type { RalphRunDetailResult } from "../../runtime.js";

export const createRalphRunResultFromDetail = (
  detail: RalphRunDetailResult,
  variables: RalphFlowVariable[] = [],
): RalphRunResult => {
  const { record } = detail;
  const checkpoint = record.checkpoint;
  const abandoned = detail.effectiveStatus === "abandoned";

  return {
    runId: record.id,
    startedAt: checkpoint?.startedAt ?? record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    flow: record.flowId,
    status: abandoned ? "crashed" : record.status,
    summary: abandoned
      ? "Run stopped before terminal state was persisted."
      : record.summary,
    events: record.events,
    blockResults:
      checkpoint?.blockResults ??
      record.blockResults.map((block) => ({
        blockId: block.blockId,
        ...(block.operationId ? { operationId: block.operationId } : {}),
        output: block.output,
        status: block.status,
        attempt: block.attempt,
        ...(block.durationMs !== undefined
          ? { durationMs: block.durationMs }
          : {}),
        ...(block.progress ? { progress: block.progress } : {}),
        ...(block.data !== undefined ? { data: block.data } : {}),
        summary: block.summary,
        ...(block.markdown ? { markdown: block.markdown } : {}),
        ...(block.error ? { error: block.error } : {}),
        ...(block.failure ? { failure: { ...block.failure } } : {}),
      })),
    missingVariables: [],
    unknownVariables: [],
    validation: {
      ...record.validation,
      errorIssues: [],
      warningIssues: [],
      variables,
    },
    ...(checkpoint?.pendingInput
      ? { pendingInput: checkpoint.pendingInput }
      : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(record.autonomy
      ? { autonomy: record.autonomy }
      : checkpoint?.autonomy
        ? { autonomy: checkpoint.autonomy }
        : {}),
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ...(record.progress ? { progress: record.progress } : {}),
    ...(record.durability ? { durability: record.durability } : {}),
  };
};
