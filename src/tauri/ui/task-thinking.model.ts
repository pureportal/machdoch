import type {
  RunMode,
  TaskExecutionProgress,
  TaskExecutionState,
} from "../../core/types.js";
import type { TaskPanelTone } from "./task-panel.model";

const THINKING_STATE_LABELS: Record<TaskExecutionState, string> = {
  starting: "Starting",
  "resolving-context": "Context",
  "checking-inputs": "Inputs",
  "checking-policies": "Policies",
  planning: "Planning",
  executing: "Executing",
  verifying: "Verifying",
  monitoring: "Monitoring",
  planned: "Plan ready",
  completed: "Completed",
  "approval-required": "Approval required",
  blocked: "Blocked",
  unsupported: "Preview only",
  cancelled: "Cancelled",
};

const THINKING_STATE_TONES: Record<TaskExecutionState, TaskPanelTone> = {
  starting: "info",
  "resolving-context": "info",
  "checking-inputs": "info",
  "checking-policies": "warning",
  planning: "info",
  executing: "info",
  verifying: "info",
  monitoring: "info",
  planned: "info",
  completed: "success",
  "approval-required": "warning",
  blocked: "danger",
  unsupported: "neutral",
  cancelled: "neutral",
};

const createThinkingEntryId = (timestamp: number, index: number): string => {
  return `thinking-${timestamp}-${index}`;
};

export interface TaskThinkingEntry {
  id: string;
  label: string;
  detail: string;
  tone: TaskPanelTone;
  timestamp: number;
}

export interface TaskThinkingModelStream {
  kind: "assistant" | "tool-call" | "reasoning" | "status" | "tool-result";
  label: string;
  content: string;
  complete?: boolean;
}

export interface TaskThinkingActionOutputLine {
  id: string;
  toolName: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
}

export interface TaskThinkingTrace {
  status: "running" | "complete";
  mode: RunMode;
  entries: TaskThinkingEntry[];
  assistantText?: string;
  modelStream?: TaskThinkingModelStream;
  actionOutputLines?: TaskThinkingActionOutputLine[];
}

export interface TaskThinkingSource {
  kind: "thinking";
  thinking: TaskThinkingTrace;
}

export const createInitialThinkingTrace = (
  mode: RunMode,
  timestamp = Date.now(),
): TaskThinkingTrace => {
  return {
    status: "running",
    mode,
    entries: [
      {
        id: createThinkingEntryId(timestamp, 0),
        label: "Starting",
        detail: "Submitting the task to the desktop runtime.",
        tone: "info",
        timestamp,
      },
    ],
  };
};

const createThinkingEntry = (
  label: string,
  detail: string,
  tone: TaskPanelTone,
  timestamp: number,
  index: number,
): TaskThinkingEntry => {
  return {
    id: createThinkingEntryId(timestamp, index),
    label,
    detail,
    tone,
    timestamp,
  };
};

const createThinkingEntriesFromProgress = (
  progress: TaskExecutionProgress,
  timestamp: number,
  startIndex: number,
): TaskThinkingEntry[] => {
  const entries: TaskThinkingEntry[] = [];
  const detail = progress.message.trim();

  if (detail.length > 0 && !progress.actionOutput) {
    entries.push(
      createThinkingEntry(
        THINKING_STATE_LABELS[progress.state],
        detail,
        THINKING_STATE_TONES[progress.state],
        timestamp,
        startIndex + entries.length,
      ),
    );
  }

  const reason = progress.reason?.trim();

  if (reason) {
    entries.push(
      createThinkingEntry(
        "Reason",
        reason,
        "warning",
        timestamp,
        startIndex + entries.length,
      ),
    );
  }

  if (progress.executedTools.length > 0) {
    entries.push(
      createThinkingEntry(
        "Tools",
        progress.executedTools.join(", "),
        "info",
        timestamp,
        startIndex + entries.length,
      ),
    );
  }

  return entries;
};

const STREAM_TEXT_LIMIT = 4_000;
const ACTION_OUTPUT_LINE_LIMIT = 80;
const ACTION_OUTPUT_LINE_LENGTH_LIMIT = 240;

const limitStreamText = (value: string): string => {
  if (value.length <= STREAM_TEXT_LIMIT) {
    return value;
  }

  return value.slice(value.length - STREAM_TEXT_LIMIT);
};

const limitOutputLine = (value: string): string => {
  const normalized = value.trimEnd();

  if (normalized.length <= ACTION_OUTPUT_LINE_LENGTH_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, ACTION_OUTPUT_LINE_LENGTH_LIMIT - 1)}...`;
};

const createActionOutputLines = (
  trace: TaskThinkingTrace,
  progress: TaskExecutionProgress,
  timestamp: number,
): TaskThinkingActionOutputLine[] => {
  const output = progress.actionOutput;

  if (!output || output.chunk.length === 0) {
    return trace.actionOutputLines ?? [];
  }

  const existingLines = trace.actionOutputLines ?? [];
  const normalizedChunk = output.chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const nextLines = normalizedChunk
    .split("\n")
    .map(limitOutputLine)
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      id: `output-${timestamp}-${existingLines.length + index}`,
      toolName: output.toolName,
      stream: output.stream,
      text: line,
      timestamp,
    }));

  if (nextLines.length === 0) {
    return existingLines;
  }

  return [...existingLines, ...nextLines].slice(-ACTION_OUTPUT_LINE_LIMIT);
};

export const appendThinkingProgress = (
  trace: TaskThinkingTrace,
  progress: TaskExecutionProgress,
  timestamp = Date.now(),
): TaskThinkingTrace => {
  const nextStatus = progress.cancellable ? trace.status : "complete";
  const nextEntries = createThinkingEntriesFromProgress(
    progress,
    timestamp,
    trace.entries.length,
  );
  const hasProgressExtras =
    progress.assistantText !== undefined ||
    progress.modelStream !== undefined ||
    progress.actionOutput !== undefined;

  if (
    nextEntries.length === 0 &&
    nextStatus === trace.status &&
    !hasProgressExtras
  ) {
    return trace;
  }

  const entries = [...trace.entries];

  for (const nextEntry of nextEntries) {
    const previousEntry = entries.at(-1);
    const hasSameToolsEntry =
      nextEntry.label === "Tools" &&
      entries.some(
        (entry) =>
          entry.label === nextEntry.label && entry.detail === nextEntry.detail,
      );

    if (
      hasSameToolsEntry ||
      (previousEntry?.label === nextEntry.label &&
        previousEntry.detail === nextEntry.detail)
    ) {
      continue;
    }

    entries.push(nextEntry);
  }

  if (entries.length === trace.entries.length && nextStatus === trace.status) {
    const nextAssistantText =
      progress.assistantText !== undefined
        ? limitStreamText(progress.assistantText)
        : trace.assistantText;
    const nextModelStream = progress.modelStream
      ? {
          ...progress.modelStream,
          content: limitStreamText(progress.modelStream.content),
        }
      : trace.modelStream;
    const nextActionOutputLines = createActionOutputLines(
      trace,
      progress,
      timestamp,
    );

    if (
      nextAssistantText === trace.assistantText &&
      nextModelStream === trace.modelStream &&
      nextActionOutputLines === trace.actionOutputLines
    ) {
      return trace;
    }

    return {
      ...trace,
      status: nextStatus,
      ...(nextAssistantText ? { assistantText: nextAssistantText } : {}),
      ...(nextModelStream ? { modelStream: nextModelStream } : {}),
      ...(nextActionOutputLines.length > 0
        ? { actionOutputLines: nextActionOutputLines }
        : {}),
    };
  }

  const nextAssistantText =
    progress.assistantText !== undefined
      ? limitStreamText(progress.assistantText)
      : trace.assistantText;
  const nextModelStream = progress.modelStream
    ? {
        ...progress.modelStream,
        content: limitStreamText(progress.modelStream.content),
      }
    : trace.modelStream;
  const nextActionOutputLines = createActionOutputLines(
    trace,
    progress,
    timestamp,
  );

  return {
    ...trace,
    status: nextStatus,
    entries,
    ...(nextAssistantText ? { assistantText: nextAssistantText } : {}),
    ...(nextModelStream ? { modelStream: nextModelStream } : {}),
    ...(nextActionOutputLines.length > 0
      ? { actionOutputLines: nextActionOutputLines }
      : {}),
  };
};
