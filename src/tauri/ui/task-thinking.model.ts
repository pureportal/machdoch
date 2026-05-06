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

  if (detail.length > 0) {
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

  if (nextEntries.length === 0 && nextStatus === trace.status) {
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
    return trace;
  }

  return {
    ...trace,
    status: nextStatus,
    entries,
  };
};
