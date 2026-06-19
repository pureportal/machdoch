import {
  truncateRalphResultText,
} from "./parse-ralph-decision.helper.js";
import type {
  RalphBlockExecutionResult,
  RalphFlow,
  RalphRunLogPaths,
  RalphRunRecord,
  RalphRunRecordBlock,
  RalphRunResult,
  RalphRunSummary,
} from "../ralph.js";

const MAX_RALPH_RUN_RECORD_DEPTH = 4;
const MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const capRunRecordText = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return truncateRalphResultText(value);
};

export const capRalphRunRecordValue = (
  value: unknown,
  depth = 0,
): unknown => {
  if (typeof value === "string") {
    return truncateRalphResultText(value);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (depth >= MAX_RALPH_RUN_RECORD_DEPTH) {
    return "[Ralph data truncated]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
      .map((entry) => capRalphRunRecordValue(entry, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
        .map(([key, entry]) => [
          key,
          capRalphRunRecordValue(entry, depth + 1),
        ]),
    );
  }

  return undefined;
};

export const createRalphRunRecordBlock = (
  blockResult: RalphBlockExecutionResult,
): RalphRunRecordBlock => {
  const task = capRunRecordText(blockResult.result?.task);
  const markdown = capRunRecordText(blockResult.markdown);
  const error = capRunRecordText(blockResult.error);

  return {
    blockId: blockResult.blockId,
    output: blockResult.output,
    status: blockResult.status,
    attempt: blockResult.attempt,
    ...(task ? { task } : {}),
    ...(blockResult.result?.status
      ? { executionStatus: blockResult.result.status }
      : {}),
    summary: truncateRalphResultText(blockResult.summary),
    ...(blockResult.data !== undefined
      ? { data: capRalphRunRecordValue(blockResult.data) }
      : {}),
    ...(markdown ? { markdown } : {}),
    ...(error ? { error } : {}),
  };
};

export const createRalphRunRecord = (
  schemaVersion: RalphRunRecord["schemaVersion"],
  id: string,
  createdAt: string,
  flow: RalphFlow,
  result: RalphRunResult,
  variableValues: Record<string, string>,
  logPaths?: RalphRunLogPaths,
): RalphRunRecord => {
  return {
    schemaVersion,
    id,
    createdAt,
    ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
    flowId: flow.id,
    flowName: flow.name,
    flowRevisionId: flow.updatedAt ?? flow.createdAt ?? null,
    status: result.status,
    summary: truncateRalphResultText(result.summary),
    variableValues: Object.fromEntries(
      Object.entries(variableValues).map(([name, value]) => [
        name,
        truncateRalphResultText(value),
      ]),
    ),
    ...(logPaths
      ? {
          logPaths: {
            simpleJsonlPath: logPaths.simpleJsonlPath,
            simpleMarkdownPath: logPaths.simpleMarkdownPath,
            traceJsonlPath: logPaths.traceJsonlPath,
          },
        }
      : {}),
    events: result.events,
    blockResults: result.blockResults.map(createRalphRunRecordBlock),
    ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
    validation: {
      valid: result.validation.valid,
      errors: result.validation.errors,
      warnings: result.validation.warnings,
    },
  };
};

export const isRalphRunRecord = (
  value: unknown,
  schemaVersion: RalphRunRecord["schemaVersion"],
): value is RalphRunRecord => {
  return (
    isRecord(value) &&
    value.schemaVersion === schemaVersion &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.flowId === "string" &&
    typeof value.flowName === "string" &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.events) &&
    Array.isArray(value.blockResults)
  );
};

export const createRalphRunSummaryFromRecord = (
  record: RalphRunRecord,
  path: string,
): RalphRunSummary => {
  return {
    id: record.id,
    path,
    createdAt: record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    flowId: record.flowId,
    flowName: record.flowName,
    status: record.status,
    summary: record.summary,
    ...(record.logPaths?.simpleMarkdownPath
      ? { simpleLogPath: record.logPaths.simpleMarkdownPath }
      : {}),
    ...(record.logPaths?.traceJsonlPath
      ? { traceLogPath: record.logPaths.traceJsonlPath }
      : {}),
    blockCount: record.blockResults.length,
    eventCount: record.events.length,
  };
};
