import type {
  TaskExecutionProgress,
  TaskExecutionState,
  TaskExecutionTimelineEvent,
  TaskExecutionTokenUsage,
} from "../../core/types.js";
import type { RunMode } from "../../core/runtime-contract.generated.js";
import type { TaskPanelTone } from "./task-panel";

const THINKING_STATE_LABELS: Record<TaskExecutionState, string> = {
  starting: "Starting",
  "resolving-context": "Context",
  "checking-inputs": "Inputs",
  "checking-tools": "Tools",
  planning: "Planning",
  executing: "Executing",
  verifying: "Verifying",
  monitoring: "Monitoring",
  planned: "Plan ready",
  completed: "Completed",
  blocked: "Blocked",
  unsupported: "Preview only",
  cancelled: "Cancelled",
};

const THINKING_STATE_TONES: Record<TaskExecutionState, TaskPanelTone> = {
  starting: "info",
  "resolving-context": "info",
  "checking-inputs": "info",
  "checking-tools": "info",
  planning: "info",
  executing: "info",
  verifying: "info",
  monitoring: "info",
  planned: "info",
  completed: "success",
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

export interface TaskThinkingTimelineEvent {
  id: string;
  kind: TaskExecutionTimelineEvent["kind"];
  phase: TaskExecutionTimelineEvent["phase"];
  label: string;
  detail: string;
  tone: TaskPanelTone;
  timestamp: number;
  elapsedMs: number;
  provider?: TaskExecutionTimelineEvent["provider"];
  model?: string;
  toolName?: string;
  callId?: string;
  stream?: "stdout" | "stderr";
  tokenUsage?: TaskExecutionTokenUsage;
  metadata?: Record<string, string | number | boolean>;
}

export interface TaskThinkingTrace {
  status: "running" | "complete";
  mode: RunMode;
  startedAt: number;
  entries: TaskThinkingEntry[];
  task?: string;
  completedAt?: number;
  assistantText?: string;
  modelStream?: TaskThinkingModelStream;
  actionOutputLines?: TaskThinkingActionOutputLine[];
  timelineEvents?: TaskThinkingTimelineEvent[];
  tokenUsage?: TaskExecutionTokenUsage;
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
    startedAt: timestamp,
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

  if (detail.length > 0 && !progress.actionOutput && !progress.timelineEvent) {
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

  if (progress.executedTools.length > 0 && !progress.timelineEvent) {
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
const TIMELINE_EVENT_LIMIT = 240;
const TIMELINE_DETAIL_LIMIT = 900;

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

const limitTimelineDetail = (value: string): string => {
  const normalized = value.trim();

  if (normalized.length <= TIMELINE_DETAIL_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, TIMELINE_DETAIL_LIMIT - 1)}...`;
};

const createTimelineEventId = (
  timestamp: number,
  index: number,
): string => {
  return `timeline-${timestamp}-${index}`;
};

const createTimelineTone = (
  event: TaskExecutionTimelineEvent,
): TaskPanelTone => {
  if (event.tone) {
    return event.tone;
  }

  switch (event.phase) {
    case "completed":
    case "passed":
      return "success";
    case "failed":
    case "rejected":
      return "danger";
    case "requested-continuation":
    case "skipped":
      return "warning";
    default:
      return "info";
  }
};

const createStateTimelineEvent = (
  progress: TaskExecutionProgress,
  timestamp: number,
  startedAt: number,
  index: number,
): TaskThinkingTimelineEvent | undefined => {
  const detail = progress.message.trim();

  if (!detail || progress.actionOutput || progress.modelStream) {
    return undefined;
  }

  return {
    id: createTimelineEventId(timestamp, index),
    kind: "state",
    phase: progress.cancellable ? "started" : "completed",
    label: THINKING_STATE_LABELS[progress.state],
    detail: limitTimelineDetail(detail),
    tone: THINKING_STATE_TONES[progress.state],
    timestamp,
    elapsedMs: Math.max(0, timestamp - startedAt),
  };
};

const createTimelineEventFromProgressEvent = (
  event: TaskExecutionTimelineEvent,
  timestamp: number,
  startedAt: number,
  index: number,
): TaskThinkingTimelineEvent => {
  const detail = limitTimelineDetail(event.detail ?? "");

  return {
    id: createTimelineEventId(timestamp, index),
    kind: event.kind,
    phase: event.phase,
    label: event.label,
    detail,
    tone: createTimelineTone(event),
    timestamp,
    elapsedMs: Math.max(0, timestamp - startedAt),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.callId ? { callId: event.callId } : {}),
    ...(event.stream ? { stream: event.stream } : {}),
    ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  };
};

const createOutputTimelineEvents = (
  progress: TaskExecutionProgress,
  timestamp: number,
  startedAt: number,
  startIndex: number,
): TaskThinkingTimelineEvent[] => {
  const output = progress.actionOutput;

  if (!output || output.chunk.length === 0) {
    return [];
  }

  return output.chunk
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(limitOutputLine)
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      id: createTimelineEventId(timestamp, startIndex + index),
      kind: "output" as const,
      phase: "streaming" as const,
      label: `${output.toolName} ${output.stream}`,
      detail: line,
      tone: output.stream === "stderr" ? "warning" : "success",
      timestamp,
      elapsedMs: Math.max(0, timestamp - startedAt),
      toolName: output.toolName,
      stream: output.stream,
    }));
};

const isSameTimelineEvent = (
  left: TaskThinkingTimelineEvent | undefined,
  right: TaskThinkingTimelineEvent,
): boolean => {
  return (
    left?.kind === right.kind &&
    left.phase === right.phase &&
    left.label === right.label &&
    left.detail === right.detail &&
    left.toolName === right.toolName &&
    left.stream === right.stream
  );
};

const appendTimelineEventCandidates = (
  existingEvents: TaskThinkingTimelineEvent[],
  candidates: TaskThinkingTimelineEvent[],
): TaskThinkingTimelineEvent[] => {
  let events = existingEvents;
  let didAppend = false;

  for (const candidate of candidates) {
    const previousEvent = events.at(-1);

    if (
      candidate.kind !== "output" &&
      !candidate.tokenUsage &&
      isSameTimelineEvent(previousEvent, candidate)
    ) {
      continue;
    }

    if (!didAppend) {
      events = [...existingEvents];
      didAppend = true;
    }

    events.push(candidate);

    if (events.length > TIMELINE_EVENT_LIMIT) {
      events = events.slice(-TIMELINE_EVENT_LIMIT);
    }
  }

  return events;
};

const createTimelineEvents = (
  trace: TaskThinkingTrace,
  progress: TaskExecutionProgress,
  timestamp: number,
): TaskThinkingTimelineEvent[] => {
  const startedAt = trace.startedAt ?? trace.entries[0]?.timestamp ?? timestamp;
  const existingEvents = trace.timelineEvents ?? [];
  const candidates: TaskThinkingTimelineEvent[] = [];

  if (progress.timelineEvent) {
    candidates.push(
      createTimelineEventFromProgressEvent(
        progress.timelineEvent,
        timestamp,
        startedAt,
        existingEvents.length + candidates.length,
      ),
    );
  }

  candidates.push(
    ...createOutputTimelineEvents(
      progress,
      timestamp,
      startedAt,
      existingEvents.length + candidates.length,
    ),
  );

  const stateEvent = createStateTimelineEvent(
    progress,
    timestamp,
    startedAt,
    existingEvents.length + candidates.length,
  );

  if (candidates.length === 0 && stateEvent) {
    candidates.push(stateEvent);
  }

  if (candidates.length === 0) {
    return existingEvents;
  }

  return appendTimelineEventCandidates(existingEvents, candidates);
};

const maxTokenCount = (
  current: number | undefined,
  next: number | undefined,
): number | undefined => {
  if (next === undefined) {
    return current;
  }

  return current === undefined ? next : Math.max(current, next);
};

const addTokenCounts = (
  current: number | undefined,
  next: number | undefined,
): number | undefined => {
  if (next === undefined) {
    return current;
  }

  return (current ?? 0) + next;
};

const TOKEN_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const satisfies ReadonlyArray<keyof TaskExecutionTokenUsage>;

type TokenUsageKey = (typeof TOKEN_USAGE_KEYS)[number];

const createTokenUsageFromKeys = (
  resolveCount: (key: TokenUsageKey) => number | undefined,
): TaskExecutionTokenUsage => {
  const usage: TaskExecutionTokenUsage = {};

  for (const key of TOKEN_USAGE_KEYS) {
    const value = resolveCount(key);

    if (value !== undefined) {
      usage[key] = value;
    }
  }

  return usage;
};

const mergeCumulativeTokenUsage = (
  current: TaskExecutionTokenUsage | undefined,
  next: TaskExecutionTokenUsage,
): TaskExecutionTokenUsage => {
  return createTokenUsageFromKeys((key) =>
    maxTokenCount(current?.[key], next[key]),
  );
};

const sumTokenUsage = (
  current: TaskExecutionTokenUsage | undefined,
  next: TaskExecutionTokenUsage,
): TaskExecutionTokenUsage => {
  return createTokenUsageFromKeys((key) =>
    addTokenCounts(current?.[key], next[key]),
  );
};

const createTokenUsageEventKey = (
  event: TaskThinkingTimelineEvent,
  index: number,
): string => {
  const modelCall = event.metadata?.modelCall;
  const executorIteration = event.metadata?.executorIteration;
  const validatorPass = event.metadata?.validatorPass;
  const scope = [
    event.provider ?? "provider",
    event.model ?? "model",
    typeof executorIteration === "number" || typeof executorIteration === "string"
      ? `executor-${executorIteration}`
      : undefined,
    typeof validatorPass === "number" || typeof validatorPass === "string"
      ? `validator-${validatorPass}`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(":");

  if (typeof modelCall === "number" || typeof modelCall === "string") {
    return `${scope}:model-call-${modelCall}`;
  }

  return event.callId
    ? `${scope}:call-${event.callId}`
    : event.id || `usage-${index}`;
};

const createTokenUsageSummary = (
  events: TaskThinkingTimelineEvent[],
): TaskExecutionTokenUsage | undefined => {
  const usageByModelCall = new Map<string, TaskExecutionTokenUsage>();

  events.forEach((event, index) => {
    const usage = event.tokenUsage;

    if (!usage) {
      return;
    }

    const key = createTokenUsageEventKey(event, index);
    const currentUsage = usageByModelCall.get(key);

    usageByModelCall.set(
      key,
      mergeCumulativeTokenUsage(currentUsage, usage),
    );
  });

  let summary: TaskExecutionTokenUsage | undefined;

  for (const usage of usageByModelCall.values()) {
    summary = sumTokenUsage(summary, usage);
  }

  return summary && Object.keys(summary).length > 0 ? summary : undefined;
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
  const startedAt = trace.startedAt ?? trace.entries[0]?.timestamp ?? timestamp;
  const task = progress.task.trim() || trace.task;
  const previousTimelineEvents = trace.timelineEvents ?? [];
  const nextTimelineEvents = createTimelineEvents(trace, progress, timestamp);
  const hasTimelineChanges =
    nextTimelineEvents !== previousTimelineEvents &&
    (nextTimelineEvents.length > 0 || previousTimelineEvents.length > 0);
  const nextEntries = createThinkingEntriesFromProgress(
    progress,
    timestamp,
    trace.entries.length,
  );
  const hasProgressExtras =
    progress.assistantText !== undefined ||
    progress.modelStream !== undefined ||
    progress.actionOutput !== undefined ||
    progress.timelineEvent !== undefined ||
    hasTimelineChanges ||
    task !== trace.task;

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
  const nextTokenUsage = hasTimelineChanges
    ? createTokenUsageSummary(nextTimelineEvents) ?? trace.tokenUsage
    : trace.tokenUsage;
  const completedAt =
    nextStatus === "complete" ? trace.completedAt ?? timestamp : trace.completedAt;

  if (entries.length === trace.entries.length && nextStatus === trace.status) {
    if (
      nextAssistantText === trace.assistantText &&
      nextModelStream === trace.modelStream &&
      nextActionOutputLines === trace.actionOutputLines &&
      !hasTimelineChanges &&
      nextTokenUsage === trace.tokenUsage &&
      completedAt === trace.completedAt &&
      task === trace.task
    ) {
      return trace;
    }

    return {
      ...trace,
      status: nextStatus,
      startedAt,
      ...(task ? { task } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(nextAssistantText ? { assistantText: nextAssistantText } : {}),
      ...(nextModelStream ? { modelStream: nextModelStream } : {}),
      ...(nextActionOutputLines.length > 0
        ? { actionOutputLines: nextActionOutputLines }
        : {}),
      ...(nextTimelineEvents.length > 0
        ? { timelineEvents: nextTimelineEvents }
        : {}),
      ...(nextTokenUsage ? { tokenUsage: nextTokenUsage } : {}),
    };
  }

  return {
    ...trace,
    status: nextStatus,
    startedAt,
    ...(task ? { task } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    entries,
    ...(nextAssistantText ? { assistantText: nextAssistantText } : {}),
    ...(nextModelStream ? { modelStream: nextModelStream } : {}),
    ...(nextActionOutputLines.length > 0
      ? { actionOutputLines: nextActionOutputLines }
      : {}),
    ...(nextTimelineEvents.length > 0
      ? { timelineEvents: nextTimelineEvents }
      : {}),
    ...(nextTokenUsage ? { tokenUsage: nextTokenUsage } : {}),
  };
};
