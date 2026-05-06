import type { RunMode, TaskExecutionState } from "../../core/types.js";
import type { TaskPanelTone } from "./task-panel.model";

const TASK_EXECUTION_STATES: ReadonlySet<TaskExecutionState> = new Set([
  "starting",
  "resolving-context",
  "checking-inputs",
  "checking-policies",
  "planning",
  "executing",
  "verifying",
  "monitoring",
  "planned",
  "completed",
  "approval-required",
  "blocked",
  "unsupported",
  "cancelled",
]);

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

const PROGRESS_STATE_PATTERN = /^\[([a-z-]+)\]\s+(.+)$/i;
const PROGRESS_REASON_PATTERN = /^reason:\s*(.+)$/i;
const PROGRESS_TOOLS_PATTERN = /^tools:\s*(.+)$/i;

const isTaskExecutionState = (value: string): value is TaskExecutionState => {
  return TASK_EXECUTION_STATES.has(value as TaskExecutionState);
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

export interface TaskThinkingTrace {
  status: "running" | "complete";
  mode: RunMode;
  entries: TaskThinkingEntry[];
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

const createThinkingEntryFromProgressLine = (
  line: string,
  timestamp: number,
  index: number,
): TaskThinkingEntry | null => {
  const normalizedLine = line.trim();

  if (!normalizedLine) {
    return null;
  }

  const stateMatch = PROGRESS_STATE_PATTERN.exec(normalizedLine);

  if (stateMatch) {
    const [, rawState, rawMessage] = stateMatch;
    const normalizedState = rawState.toLowerCase();

    if (isTaskExecutionState(normalizedState)) {
      return {
        id: createThinkingEntryId(timestamp, index),
        label: THINKING_STATE_LABELS[normalizedState],
        detail: rawMessage.trim(),
        tone: THINKING_STATE_TONES[normalizedState],
        timestamp,
      };
    }
  }

  const reasonMatch = PROGRESS_REASON_PATTERN.exec(normalizedLine);

  if (reasonMatch) {
    return {
      id: createThinkingEntryId(timestamp, index),
      label: "Reason",
      detail: reasonMatch[1].trim(),
      tone: "warning",
      timestamp,
    };
  }

  const toolsMatch = PROGRESS_TOOLS_PATTERN.exec(normalizedLine);

  if (toolsMatch) {
    return {
      id: createThinkingEntryId(timestamp, index),
      label: "Tools",
      detail: toolsMatch[1].trim(),
      tone: "info",
      timestamp,
    };
  }

  return {
    id: createThinkingEntryId(timestamp, index),
    label: "Update",
    detail: normalizedLine,
    tone: "neutral",
    timestamp,
  };
};

export const appendThinkingProgressLine = (
  trace: TaskThinkingTrace,
  line: string,
  timestamp = Date.now(),
): TaskThinkingTrace => {
  const nextEntry = createThinkingEntryFromProgressLine(
    line,
    timestamp,
    trace.entries.length,
  );

  if (!nextEntry) {
    return trace;
  }

  const previousEntry = trace.entries.at(-1);

  if (
    previousEntry?.label === nextEntry.label &&
    previousEntry.detail === nextEntry.detail
  ) {
    return trace;
  }

  return {
    ...trace,
    entries: [...trace.entries, nextEntry],
  };
};
