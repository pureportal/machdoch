import {
  truncateRalphResultText,
} from "./parse-ralph-decision.helper.js";
import type {
  RalphBlockExecutionResult,
  RalphFlow,
  RalphRunRecordBlockProgressEvent,
  RalphRunLogPaths,
  RalphRunRecord,
  RalphRunRecordBlock,
  RalphRunResult,
  RalphRunSummary,
} from "../ralph.js";
import type {
  TaskExecutionNarrative,
  TaskExecutionSection,
} from "../types.js";

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

const capRunRecordTextArray = (
  values: readonly string[] | undefined,
): string[] | undefined => {
  if (!values || values.length === 0) {
    return undefined;
  }

  return values
    .slice(0, MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
    .map((value) => truncateRalphResultText(value));
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

const capRalphRunRecordOutputSections = (
  sections: TaskExecutionSection[] | undefined,
): TaskExecutionSection[] | undefined => {
  if (!sections || sections.length === 0) {
    return undefined;
  }

  return sections
    .slice(0, MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
    .map((section) => ({
      title: truncateRalphResultText(section.title),
      lines: section.lines
        .slice(0, MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
        .map((line) => truncateRalphResultText(line)),
      ...(section.audience ? { audience: section.audience } : {}),
      ...(section.tone ? { tone: section.tone } : {}),
    }));
};

const capRalphRunRecordResponse = (
  response: TaskExecutionNarrative | undefined,
): TaskExecutionNarrative | undefined => {
  if (!response) {
    return undefined;
  }

  return {
    markdown: truncateRalphResultText(response.markdown),
    highlights: capRunRecordTextArray(response.highlights) ?? [],
    relatedFiles: response.relatedFiles
      .slice(0, MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
      .map((file) => ({
        path: truncateRalphResultText(file.path),
        description: truncateRalphResultText(file.description),
      })),
    verification: capRunRecordTextArray(response.verification) ?? [],
    followUps: capRunRecordTextArray(response.followUps) ?? [],
  };
};

const capRalphRunRecordProgressEvents = (
  progress: RalphRunRecordBlockProgressEvent[] | undefined,
): RalphRunRecordBlockProgressEvent[] | undefined => {
  if (!progress || progress.length === 0) {
    return undefined;
  }

  return progress
    .slice(-MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
    .map((event) => ({
      timestamp: event.timestamp,
      kind: event.kind,
      label: truncateRalphResultText(event.label),
      ...(event.timelineKind ? { timelineKind: event.timelineKind } : {}),
      ...(event.streamKind ? { streamKind: event.streamKind } : {}),
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.tone ? { tone: event.tone } : {}),
      ...(event.provider ? { provider: event.provider } : {}),
      ...(event.model ? { model: truncateRalphResultText(event.model) } : {}),
      ...(event.complete !== undefined ? { complete: event.complete } : {}),
      ...(event.toolName
        ? { toolName: truncateRalphResultText(event.toolName) }
        : {}),
      ...(event.stream ? { stream: event.stream } : {}),
      ...(event.content
        ? { content: truncateRalphResultText(event.content) }
        : {}),
      ...(event.detail ? { detail: truncateRalphResultText(event.detail) } : {}),
      ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    }));
};

export const createRalphRunRecordBlock = (
  blockResult: RalphBlockExecutionResult,
): RalphRunRecordBlock => {
  const task = capRunRecordText(blockResult.result?.task);
  const reason = capRunRecordText(blockResult.result?.reason);
  const markdown = capRunRecordText(blockResult.markdown);
  const error = capRunRecordText(blockResult.error);
  const executedTools = blockResult.result?.executedTools.length
    ? blockResult.result.executedTools
        .slice(0, MAX_RALPH_RUN_RECORD_COLLECTION_ENTRIES)
    : undefined;
  const outputSections = capRalphRunRecordOutputSections(
    blockResult.result?.outputSections,
  );
  const response = capRalphRunRecordResponse(blockResult.result?.response);
  const progress = capRalphRunRecordProgressEvents(blockResult.progress);

  return {
    blockId: blockResult.blockId,
    ...(blockResult.operationId ? { operationId: blockResult.operationId } : {}),
    output: blockResult.output,
    status: blockResult.status,
    attempt: blockResult.attempt,
    ...(blockResult.durationMs !== undefined
      ? { durationMs: blockResult.durationMs }
      : {}),
    ...(task ? { task } : {}),
    ...(blockResult.result?.status
      ? { executionStatus: blockResult.result.status }
      : {}),
    ...(reason ? { reason } : {}),
    ...(executedTools ? { executedTools } : {}),
    ...(outputSections ? { outputSections } : {}),
    ...(response ? { response } : {}),
    ...(progress ? { progress } : {}),
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
    ...(result.durability ? { durability: { ...result.durability } } : {}),
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
