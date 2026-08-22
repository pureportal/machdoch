import type { TaskPanelTone } from "./task-panel";
import type {
  TaskThinkingActionOutputLine,
  TaskThinkingTimelineEvent,
  TaskThinkingTrace,
} from "./task-thinking.model";

type StoryKind = TaskThinkingTimelineEvent["kind"] | "terminal";

export interface TaskExecutionStoryItem {
  id: string;
  kind: StoryKind;
  phase: TaskThinkingTimelineEvent["phase"];
  label: string;
  sourceLabel: string;
  detail: string;
  startedDetail?: string;
  tone: TaskPanelTone;
  timestamp: number;
  elapsedMs: number;
  endedAt?: number;
  durationMs?: number;
  provider?: TaskThinkingTimelineEvent["provider"];
  model?: string;
  toolName?: string;
  callId?: string;
  tokenUsage?: TaskThinkingTimelineEvent["tokenUsage"];
  metadata?: TaskThinkingTimelineEvent["metadata"];
  outputLines: TaskThinkingActionOutputLine[];
}

interface TimelineSource {
  type: "event";
  timestamp: number;
  priority: number;
  order: number;
  event: TaskThinkingTimelineEvent;
}

interface OutputSource {
  type: "output";
  timestamp: number;
  priority: number;
  order: number;
  line: TaskThinkingActionOutputLine;
}

type StorySource = TimelineSource | OutputSource;

const LIFECYCLE_KINDS = new Set<TaskThinkingTimelineEvent["kind"]>([
  "model-call",
  "tool-call",
  "validator",
]);

const TERMINAL_PHASES = new Set<TaskThinkingTimelineEvent["phase"]>([
  "completed",
  "failed",
  "skipped",
  "passed",
  "requested-continuation",
  "rejected",
]);

const formatToolSubject = (event: TaskThinkingTimelineEvent): string => {
  const label = event.label.replace(/^tool call:\s*/iu, "").trim();

  return label || event.toolName || "Tool";
};

const formatModelSubject = (label: string): string => {
  const executorMatch = /^executor model call (\d+)$/iu.exec(label);

  if (executorMatch) {
    return `AI pass ${executorMatch[1]}`;
  }

  const validatorMatch = /^validator model call (\d+)$/iu.exec(label);

  if (validatorMatch) {
    return `Verification pass ${validatorMatch[1]}`;
  }

  return label;
};

const createNarrativeLabel = (event: TaskThinkingTimelineEvent): string => {
  if (event.kind === "tool-call") {
    const subject = formatToolSubject(event);

    switch (event.phase) {
      case "started":
      case "streaming":
        return `Running ${subject}`;
      case "completed":
      case "passed":
        return `Ran ${subject}`;
      case "failed":
      case "rejected":
        return `${subject} failed`;
      case "skipped":
        return `Skipped ${subject}`;
      default:
        return event.label;
    }
  }

  if (event.kind === "model-call") {
    if (/[.!?]$/u.test(event.label)) {
      return event.label;
    }

    const subject = formatModelSubject(event.label);

    switch (event.phase) {
      case "started":
      case "streaming":
        return `${subject} started`;
      case "completed":
      case "passed":
        return `${subject} finished`;
      case "failed":
      case "rejected":
        return `${subject} failed`;
      default:
        return subject;
    }
  }

  if (
    event.kind === "validator" &&
    /^validator pass \d+$/iu.test(event.label)
  ) {
    switch (event.phase) {
      case "started":
      case "streaming":
        return "Checking the result";
      case "passed":
        return "Result verified";
      case "requested-continuation":
        return "More work needed";
      case "failed":
      case "rejected":
        return "Verification failed";
      default:
        return "Checked the result";
    }
  }

  return event.label;
};

const createLifecycleKey = (event: TaskThinkingTimelineEvent): string => {
  if (event.kind === "tool-call") {
    return `tool:${event.callId ?? `${event.toolName ?? "tool"}:${event.label}`}`;
  }

  const executorIteration = event.metadata?.executorIteration ?? "";
  const modelCall = event.metadata?.modelCall ?? "";
  const validatorPass = event.metadata?.validatorPass ?? "";

  return [
    event.kind,
    event.provider ?? "",
    event.model ?? "",
    executorIteration,
    modelCall,
    validatorPass,
    event.label,
  ].join(":");
};

const createStoryItem = (
  event: TaskThinkingTimelineEvent,
): TaskExecutionStoryItem => {
  const durationMs = event.metadata?.durationMs;

  return {
    id: event.id,
    kind: event.kind,
    phase: event.phase,
    label: createNarrativeLabel(event),
    sourceLabel: event.label,
    detail: event.detail,
    tone: event.tone,
    timestamp: event.timestamp,
    elapsedMs: event.elapsedMs,
    ...(typeof durationMs === "number" ? { durationMs } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.callId ? { callId: event.callId } : {}),
    ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
    outputLines: [],
  };
};

const mergeLifecycleEvent = (
  item: TaskExecutionStoryItem,
  event: TaskThinkingTimelineEvent,
): TaskExecutionStoryItem => {
  const metadata = { ...item.metadata, ...event.metadata };
  const reportedDurationMs = event.metadata?.durationMs;
  const durationMs =
    typeof reportedDurationMs === "number"
      ? reportedDurationMs
      : Math.max(0, event.timestamp - item.timestamp);
  const startedDetail =
    item.detail && item.detail !== event.detail
      ? item.detail
      : item.startedDetail;

  return {
    ...item,
    phase: event.phase,
    label: createNarrativeLabel(event),
    sourceLabel: event.label,
    detail: event.detail || item.detail,
    tone: event.tone,
    endedAt: event.timestamp,
    durationMs,
    ...(startedDetail ? { startedDetail } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.callId ? { callId: event.callId } : {}),
    ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};

const isSameUsageScope = (
  item: TaskExecutionStoryItem,
  event: TaskThinkingTimelineEvent,
): boolean => {
  const scopeKeys = [
    "executorIteration",
    "modelCall",
    "validatorPass",
  ] as const;
  const populatedKeys = scopeKeys.filter(
    (key) => event.metadata?.[key] !== undefined,
  );

  return populatedKeys.every(
    (key) => item.metadata?.[key] === event.metadata?.[key],
  );
};

const attachUsageEvent = (
  items: TaskExecutionStoryItem[],
  event: TaskThinkingTimelineEvent,
): void => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item.kind !== "model-call" || !isSameUsageScope(item, event)) {
      continue;
    }

    items[index] = {
      ...item,
      ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
      metadata: { ...item.metadata, ...event.metadata },
    };
    return;
  }
};

const formatOutputSummary = (
  toolName: string,
  lines: TaskThinkingActionOutputLine[],
): string => {
  const streams = new Set(lines.map((line) => line.stream));
  const streamLabel =
    streams.size === 1 ? (lines[0]?.stream ?? "output") : "stdout and stderr";

  return `${toolName} · ${lines.length} ${streamLabel} line${lines.length === 1 ? "" : "s"}`;
};

const appendOutputLine = (
  items: TaskExecutionStoryItem[],
  line: TaskThinkingActionOutputLine,
  startedAt: number,
): void => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (
      item.kind !== "tool-call" ||
      item.endedAt !== undefined ||
      item.toolName !== line.toolName
    ) {
      continue;
    }

    items[index] = {
      ...item,
      outputLines: [...item.outputLines, line],
    };
    return;
  }

  const previousItem = items.at(-1);

  if (
    previousItem?.kind === "terminal" &&
    previousItem.toolName === line.toolName
  ) {
    const outputLines = [...previousItem.outputLines, line];

    items[items.length - 1] = {
      ...previousItem,
      detail: formatOutputSummary(line.toolName, outputLines),
      endedAt: line.timestamp,
      outputLines,
    };
    return;
  }

  items.push({
    id: `terminal:${line.toolName}:after:${previousItem?.id ?? "execution-start"}`,
    kind: "terminal",
    phase: "streaming",
    label: "Terminal activity",
    sourceLabel: `${line.toolName} terminal output`,
    detail: formatOutputSummary(line.toolName, [line]),
    tone: "neutral",
    timestamp: line.timestamp,
    elapsedMs: Math.max(0, line.timestamp - startedAt),
    endedAt: line.timestamp,
    toolName: line.toolName,
    outputLines: [line],
  });
};

const createStorySources = (trace: TaskThinkingTrace): StorySource[] => {
  const eventSources: TimelineSource[] = trace.timelineEvents.map(
    (event, order) => ({
      type: "event",
      timestamp: event.timestamp,
      priority:
        event.phase === "started"
          ? 0
          : TERMINAL_PHASES.has(event.phase)
            ? 2
            : 1,
      order,
      event,
    }),
  );
  const outputSources: OutputSource[] = (trace.actionOutputLines ?? []).map(
    (line, order) => ({
      type: "output",
      timestamp: line.timestamp,
      priority: 1,
      order,
      line,
    }),
  );

  return [...eventSources, ...outputSources].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      left.priority - right.priority ||
      left.order - right.order,
  );
};

export const createTaskExecutionStory = (
  trace: TaskThinkingTrace,
): TaskExecutionStoryItem[] => {
  const items: TaskExecutionStoryItem[] = [];
  const pendingLifecycleItems = new Map<string, number>();

  for (const source of createStorySources(trace)) {
    if (source.type === "output") {
      appendOutputLine(items, source.line, trace.startedAt);
      continue;
    }

    const event = source.event;

    if (event.kind === "model-call" && event.phase === "usage") {
      attachUsageEvent(items, event);
      continue;
    }

    if (!LIFECYCLE_KINDS.has(event.kind)) {
      items.push(createStoryItem(event));
      continue;
    }

    const lifecycleKey = createLifecycleKey(event);

    if (event.phase === "started") {
      items.push(createStoryItem(event));
      pendingLifecycleItems.set(lifecycleKey, items.length - 1);
      continue;
    }

    const pendingIndex = pendingLifecycleItems.get(lifecycleKey);

    if (pendingIndex !== undefined && TERMINAL_PHASES.has(event.phase)) {
      items[pendingIndex] = mergeLifecycleEvent(items[pendingIndex], event);
      pendingLifecycleItems.delete(lifecycleKey);
      continue;
    }

    items.push(createStoryItem(event));
  }

  return items;
};
