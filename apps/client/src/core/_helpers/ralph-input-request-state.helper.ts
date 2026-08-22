import { randomUUID } from "node:crypto";
import {
  getRalphInputFieldVariableNames,
  stringifyRalphInputValue,
} from "./normalize-ralph-input-response-values.helper.js";
import type {
  RalphBlockExecutionResult,
  RalphFlowBlock,
  RalphAskUserBlock,
  RalphInputField,
  RalphInputFieldType,
  RalphInputRequest,
  RalphInputResponse,
  RalphInputValue,
  RalphInterviewState,
  RalphInterviewBlock,
  RalphRepeatedFailureState,
  RalphRunCheckpoint,
  RalphRunEvent,
  RalphRunOptions,
  RalphMediaRunCheckpoint,
} from "../ralph.js";

interface RalphInputContext {
  runId: string;
  variables: Record<string, string>;
}

interface RalphCheckpointContext extends RalphInputContext {
  resultsByBlock: Map<string, RalphBlockExecutionResult>;
  runLog: string[];
  interviewStates: Map<string, RalphInterviewState>;
  mediaRuns?: Map<string, RalphMediaRunCheckpoint>;
}

type RalphTemplateResolver<Context extends RalphInputContext> = (
  text: string,
  context: Context,
) => string;

const RALPH_INPUT_FIELD_TYPES: readonly RalphInputFieldType[] = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "multiselect",
  "url",
  "path",
  "file",
  "files",
  "image",
  "images",
];

const RALPH_INPUT_FIELD_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const isRalphInputFieldType = (value: string): value is RalphInputFieldType => {
  return RALPH_INPUT_FIELD_TYPES.includes(value as RalphInputFieldType);
};

export const normalizeGeneratedInputFieldId = (
  value: string | undefined,
  fallback: string,
): string => {
  const normalized = (value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^[^A-Za-z_]+/u, "")
    .slice(0, 80);

  if (normalized && RALPH_INPUT_FIELD_ID_PATTERN.test(normalized)) {
    return normalized;
  }

  return fallback;
};

export const applyInputValuesToContext = (
  context: RalphInputContext,
  fields: RalphInputField[],
  values: Record<string, RalphInputValue>,
): void => {
  for (const field of fields) {
    const value = values[field.id] ?? null;

    for (const variableName of getRalphInputFieldVariableNames(field)) {
      context.variables[variableName] = stringifyRalphInputValue(value);
    }
  }
};

const resolveInputFieldForRequest = <Context extends RalphInputContext>(
  field: RalphInputField,
  context: Context,
  resolveTemplateText: RalphTemplateResolver<Context>,
): RalphInputField => {
  return {
    ...field,
    label: resolveTemplateText(field.label, context),
    ...(field.placeholder
      ? { placeholder: resolveTemplateText(field.placeholder, context) }
      : {}),
    ...(field.help ? { help: resolveTemplateText(field.help, context) } : {}),
    ...(typeof field.defaultValue === "string"
      ? { defaultValue: resolveTemplateText(field.defaultValue, context) }
      : field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : {}),
    ...(field.options
      ? {
          options: field.options.map((option) => ({
            value: option.value,
            label: resolveTemplateText(option.label, context),
          })),
        }
      : {}),
  };
};

export const createInputRequest = <Context extends RalphInputContext>(
  block: RalphAskUserBlock | RalphInterviewBlock,
  context: Context,
  fields: RalphInputField[],
  resolveTemplateText: RalphTemplateResolver<Context>,
  options: {
    prompt?: string;
    submitLabel?: string;
    cancelLabel?: string;
    timeoutSeconds?: number | null;
    interview?: RalphInputRequest["interview"];
  } = {},
): RalphInputRequest => {
  const createdAt = new Date();
  const timeoutSeconds = options.timeoutSeconds ?? null;

  return {
    id: `ralph-input-${block.id}-${randomUUID()}`,
    runId: context.runId,
    blockId: block.id,
    blockType: block.type,
    title: block.title,
    ...(options.prompt ? { prompt: resolveTemplateText(options.prompt, context) } : {}),
    fields: fields.map((field) =>
      resolveInputFieldForRequest(field, context, resolveTemplateText),
    ),
    ...(options.submitLabel ? { submitLabel: options.submitLabel } : {}),
    ...(options.cancelLabel ? { cancelLabel: options.cancelLabel } : {}),
    createdAt: createdAt.toISOString(),
    ...(timeoutSeconds !== null && timeoutSeconds > 0
      ? {
          expiresAt: new Date(
            createdAt.getTime() + timeoutSeconds * 1000,
          ).toISOString(),
        }
      : {}),
    ...(options.interview ? { interview: options.interview } : {}),
  };
};

export const getPendingInputForBlock = (
  block: RalphFlowBlock,
  options: RalphRunOptions,
): RalphInputRequest | undefined => {
  const pendingInput = options.checkpoint?.pendingInput;

  return pendingInput?.blockId === block.id ? pendingInput : undefined;
};

export const getMatchingInputResponse = (
  block: RalphFlowBlock,
  options: RalphRunOptions,
): RalphInputResponse | undefined => {
  const pendingInput = getPendingInputForBlock(block, options);
  const response = options.inputResponse;

  if (!pendingInput || !response || response.requestId !== pendingInput.id) {
    return undefined;
  }

  return response;
};

export const isExpiredInputRequest = (request: RalphInputRequest): boolean => {
  return Boolean(request.expiresAt && Date.parse(request.expiresAt) <= Date.now());
};

export const createRunCheckpoint = (
  currentBlockId: string,
  transitions: number,
  context: RalphCheckpointContext,
  blockResults: RalphBlockExecutionResult[],
  events: RalphRunEvent[],
  errorCounts: Map<string, number>,
  repeatedFailures: Map<string, RalphRepeatedFailureState>,
  pendingInput?: RalphInputRequest,
): RalphRunCheckpoint => {
  return {
    currentBlockId,
    transitions,
    variables: { ...context.variables },
    resultsByBlock: Object.fromEntries(context.resultsByBlock.entries()),
    runLog: [...context.runLog],
    blockResults: [...blockResults],
    events: [...events],
    errorCounts: Object.fromEntries(errorCounts.entries()),
    repeatedFailures: Object.fromEntries(repeatedFailures.entries()),
    ...(pendingInput ? { pendingInput } : {}),
    interviewStates: Object.fromEntries(context.interviewStates.entries()),
    ...(context.mediaRuns
      ? { mediaRuns: Object.fromEntries(context.mediaRuns.entries()) }
      : {}),
  };
};

export const restoreRalphResultMap = (
  checkpoint: RalphRunCheckpoint | undefined,
): Map<string, RalphBlockExecutionResult> => {
  return new Map(Object.entries(checkpoint?.resultsByBlock ?? {}));
};

export const restoreRalphNumberMap = (
  values: Record<string, number> | undefined,
): Map<string, number> => {
  return new Map(
    Object.entries(values ?? {}).filter((entry): entry is [string, number] =>
      Number.isFinite(entry[1]),
    ),
  );
};

export const restoreRalphRepeatedFailureMap = (
  values: Record<string, RalphRepeatedFailureState> | undefined,
): Map<string, RalphRepeatedFailureState> => {
  return new Map(
    Object.entries(values ?? {}).filter((entry): entry is [string, RalphRepeatedFailureState] => {
      const state = entry[1];

      return (
        isRecord(state) &&
        typeof state.signature === "string" &&
        typeof state.count === "number"
      );
    }),
  );
};
