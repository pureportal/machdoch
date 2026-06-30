import type {
  RalphFlowScope,
  RalphRunRecordBlockProgressEvent,
} from "../../../../core/ralph.js";
import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import type { TaskExecutionProgress } from "../../../../core/types.js";
import type { RuntimeProvider } from "../../model-catalog";
import { titleFromId } from "./format-ralph-flow-labels.helper";

export type ActiveRalphRunStatus = "running" | "stopping";
export type RalphRunEventTone = NonNullable<
  NonNullable<TaskExecutionProgress["timelineEvent"]>["tone"]
>;
export type RalphRunEventPhase =
  NonNullable<TaskExecutionProgress["timelineEvent"]>["phase"];

export interface ActiveRalphRun {
  id: string;
  flowId: string;
  scope: RalphFlowScope;
  flowName: string;
  startedAt: number;
  status: ActiveRalphRunStatus;
  mode: RunMode;
  provider: RuntimeProvider;
  model: string;
  reasoning?: ReasoningMode;
  maxTransitions?: number;
  variableValues: Record<string, string>;
  events: ActiveRalphRunEvent[];
  currentBlockId?: string;
  currentBlockTitle?: string;
  lastEventType?: string;
  lastOutput?: string;
  lastMessage?: string;
  blockDetails: Record<string, ActiveRalphRunBlockDetail>;
}

export interface ActiveRalphRunEvent {
  id: string;
  timestamp: number;
  eventType: string;
  label: string;
  phase: RalphRunEventPhase;
  tone: RalphRunEventTone;
  blockId?: string;
  blockTitle?: string;
  activeBlockId?: string;
  activeBlockTitle?: string;
  nextBlockId?: string;
  nextBlockTitle?: string;
  output?: string;
  attempt?: number;
  detail?: string;
}

export interface ActiveRalphRunBlockDetail {
  blockId: string;
  blockTitle?: string;
  output?: string;
  status?: string;
  attempt?: number;
  summary?: string;
  events: ActiveRalphRunEvent[];
  progress: RalphRunRecordBlockProgressEvent[];
}

type RalphProgressMetadata =
  NonNullable<TaskExecutionProgress["timelineEvent"]>["metadata"];

interface RalphProgressSnapshot {
  eventType: string;
  label: string;
  phase: RalphRunEventPhase;
  tone: RalphRunEventTone;
  blockId?: string;
  blockTitle?: string;
  activeBlockId?: string;
  activeBlockTitle?: string;
  nextBlockId?: string;
  nextBlockTitle?: string;
  output?: string;
  attempt?: number;
  detail?: string;
}

interface RalphBlockProgressSnapshot {
  blockId: string;
  blockTitle?: string;
  event: RalphRunRecordBlockProgressEvent;
}

const RALPH_PROGRESS_EVENT_TYPES = new Set([
  "block-start",
  "block-output",
  "edge-route",
  "retry",
  "input-required",
  "input-submitted",
  "input-cancelled",
  "crash",
  "end",
]);

const RALPH_GENERATION_ACTIVITY_LIMIT = 80;
const RALPH_BLOCK_PROGRESS_LIMIT = 120;

export const getProgressMetadataString = (
  metadata: RalphProgressMetadata | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];

  return typeof value === "string" && value.trim() ? value : undefined;
};

export const getProgressMetadataNumber = (
  metadata: RalphProgressMetadata | undefined,
  key: string,
): number | undefined => {
  const value = metadata?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const getProgressMetadataBoolean = (
  metadata: RalphProgressMetadata | undefined,
  key: string,
): boolean | undefined => {
  const value = metadata?.[key];

  return typeof value === "boolean" ? value : undefined;
};

const createIsoTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);

  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

const getRalphProgressBlockReference = (
  progress: TaskExecutionProgress,
): { blockId: string; blockTitle?: string } | null => {
  const metadata = progress.timelineEvent?.metadata;
  const blockId =
    getProgressMetadataString(metadata, "ralphActiveBlockId") ??
    getProgressMetadataString(metadata, "ralphBlockId");

  if (!blockId) {
    return null;
  }

  const blockTitle =
    getProgressMetadataString(metadata, "ralphActiveBlockTitle") ??
    getProgressMetadataString(metadata, "ralphBlockTitle");

  return {
    blockId,
    ...(blockTitle ? { blockTitle } : {}),
  };
};

export const createRalphBlockProgressSnapshot = (
  progress: TaskExecutionProgress,
  timestamp: number,
): RalphBlockProgressSnapshot | null => {
  const blockReference = getRalphProgressBlockReference(progress);

  if (!blockReference) {
    return null;
  }

  const createdAt = createIsoTimestamp(timestamp);

  if (progress.modelStream) {
    return {
      ...blockReference,
      event: {
        timestamp: createdAt,
        kind: "model-stream",
        label: progress.modelStream.label,
        streamKind: progress.modelStream.kind,
        content: progress.modelStream.content,
        ...(progress.modelStream.complete !== undefined
          ? { complete: progress.modelStream.complete }
          : {}),
      },
    };
  }

  if (progress.actionOutput) {
    return {
      ...blockReference,
      event: {
        timestamp: createdAt,
        kind: "action-output",
        label: `${progress.actionOutput.toolName} ${progress.actionOutput.stream}`,
        toolName: progress.actionOutput.toolName,
        stream: progress.actionOutput.stream,
        content: progress.actionOutput.chunk,
      },
    };
  }

  if (progress.timelineEvent) {
    return {
      ...blockReference,
      event: {
        timestamp: createdAt,
        kind: "timeline",
        label: progress.timelineEvent.label,
        phase: progress.timelineEvent.phase,
        ...(progress.timelineEvent.tone
          ? { tone: progress.timelineEvent.tone }
          : {}),
        ...(progress.timelineEvent.toolName
          ? { toolName: progress.timelineEvent.toolName }
          : {}),
        ...(progress.timelineEvent.detail
          ? { detail: progress.timelineEvent.detail }
          : {}),
      },
    };
  }

  return {
    ...blockReference,
    event: {
      timestamp: createdAt,
      kind: "message",
      label: progress.message,
      detail: progress.message,
    },
  };
};

export const getRalphProgressSnapshot = (
  progress: TaskExecutionProgress,
): RalphProgressSnapshot | null => {
  const metadata = progress.timelineEvent?.metadata;
  const eventType = getProgressMetadataString(metadata, "ralphEventType");

  if (!eventType || !RALPH_PROGRESS_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const activeBlockId =
    getProgressMetadataString(metadata, "ralphActiveBlockId") ??
    getProgressMetadataString(metadata, "ralphBlockId");
  const blockId = getProgressMetadataString(metadata, "ralphBlockId");
  const blockTitle = getProgressMetadataString(metadata, "ralphBlockTitle");
  const activeBlockTitle =
    getProgressMetadataString(metadata, "ralphActiveBlockTitle") ??
    blockTitle ??
    activeBlockId;
  const nextBlockId = getProgressMetadataString(metadata, "ralphNextBlockId");
  const nextBlockTitle = getProgressMetadataString(
    metadata,
    "ralphNextBlockTitle",
  );
  const phase: RalphRunEventPhase =
    progress.timelineEvent?.phase ??
    (eventType === "crash"
      ? "failed"
      : eventType === "end" ||
          eventType === "block-output" ||
          eventType === "input-submitted" ||
          eventType === "input-cancelled"
        ? "completed"
        : "started");
  const tone: RalphRunEventTone =
    progress.timelineEvent?.tone ??
    (eventType === "crash"
      ? "danger"
      : eventType === "retry"
        ? "warning"
        : eventType === "input-cancelled"
          ? "warning"
          : eventType === "end"
            ? "success"
            : "info");

  return {
    eventType,
    label: progress.timelineEvent?.label || progress.message || eventType,
    phase,
    tone,
    ...(blockId ? { blockId } : {}),
    ...(blockTitle ? { blockTitle } : {}),
    ...(activeBlockId ? { activeBlockId } : {}),
    ...(activeBlockTitle ? { activeBlockTitle } : {}),
    ...(nextBlockId ? { nextBlockId } : {}),
    ...(nextBlockTitle ? { nextBlockTitle } : {}),
    ...(getProgressMetadataString(metadata, "ralphOutput")
      ? { output: getProgressMetadataString(metadata, "ralphOutput") }
      : {}),
    ...(getProgressMetadataNumber(metadata, "ralphAttempt") !== undefined
      ? { attempt: getProgressMetadataNumber(metadata, "ralphAttempt") }
      : {}),
    ...(progress.timelineEvent?.detail
      ? { detail: progress.timelineEvent.detail }
      : {}),
  };
};

const getActiveRunBlockDetail = (
  run: ActiveRalphRun,
  blockId: string,
  blockTitle?: string,
): ActiveRalphRunBlockDetail => {
  return (
    run.blockDetails[blockId] ?? {
      blockId,
      ...(blockTitle ? { blockTitle } : {}),
      events: [],
      progress: [],
    }
  );
};

export const applyActiveRunEventSnapshot = (
  run: ActiveRalphRun,
  snapshot: RalphProgressSnapshot,
  timestamp: number,
): ActiveRalphRun => {
  const runEvent: ActiveRalphRunEvent = {
    id: `${timestamp}-${snapshot.eventType}-${snapshot.blockId ?? snapshot.activeBlockId ?? "run"}-${run.events.length}`,
    timestamp,
    eventType: snapshot.eventType,
    label: snapshot.label,
    phase: snapshot.phase,
    tone: snapshot.tone,
    ...(snapshot.blockId ? { blockId: snapshot.blockId } : {}),
    ...(snapshot.blockTitle ? { blockTitle: snapshot.blockTitle } : {}),
    ...(snapshot.activeBlockId
      ? { activeBlockId: snapshot.activeBlockId }
      : {}),
    ...(snapshot.activeBlockTitle
      ? { activeBlockTitle: snapshot.activeBlockTitle }
      : {}),
    ...(snapshot.nextBlockId ? { nextBlockId: snapshot.nextBlockId } : {}),
    ...(snapshot.nextBlockTitle
      ? { nextBlockTitle: snapshot.nextBlockTitle }
      : {}),
    ...(snapshot.output ? { output: snapshot.output } : {}),
    ...(snapshot.attempt !== undefined ? { attempt: snapshot.attempt } : {}),
    ...(snapshot.detail ? { detail: snapshot.detail } : {}),
  };
  const blockId = snapshot.blockId ?? snapshot.activeBlockId;
  const blockTitle = snapshot.blockTitle ?? snapshot.activeBlockTitle;
  const currentDetail = blockId
    ? getActiveRunBlockDetail(run, blockId, blockTitle)
    : null;
  const nextBlockDetails = currentDetail
    ? {
        ...run.blockDetails,
        [currentDetail.blockId]: {
          ...currentDetail,
          ...(blockTitle ? { blockTitle } : {}),
          ...(snapshot.output ? { output: snapshot.output } : {}),
          ...(snapshot.attempt !== undefined ? { attempt: snapshot.attempt } : {}),
          ...(snapshot.eventType === "block-output"
            ? { status: "completed", summary: snapshot.detail ?? snapshot.label }
            : {}),
          ...(snapshot.eventType === "crash"
            ? { status: "error", summary: snapshot.detail ?? snapshot.label }
            : {}),
          events: [...currentDetail.events, runEvent].slice(
            -RALPH_GENERATION_ACTIVITY_LIMIT,
          ),
        },
      }
    : run.blockDetails;

  return {
    ...run,
    ...(snapshot.activeBlockId
      ? { currentBlockId: snapshot.activeBlockId }
      : {}),
    ...(snapshot.activeBlockTitle
      ? { currentBlockTitle: snapshot.activeBlockTitle }
      : {}),
    lastEventType: snapshot.eventType,
    lastMessage: snapshot.label,
    ...(snapshot.output ? { lastOutput: snapshot.output } : {}),
    events: [...run.events, runEvent].slice(-RALPH_GENERATION_ACTIVITY_LIMIT),
    blockDetails: nextBlockDetails,
  };
};

export const applyActiveRunBlockProgressSnapshot = (
  run: ActiveRalphRun,
  snapshot: RalphBlockProgressSnapshot,
): ActiveRalphRun => {
  const currentDetail = getActiveRunBlockDetail(
    run,
    snapshot.blockId,
    snapshot.blockTitle,
  );

  return {
    ...run,
    currentBlockId: snapshot.blockId,
    ...(snapshot.blockTitle ? { currentBlockTitle: snapshot.blockTitle } : {}),
    lastMessage: snapshot.event.label,
    blockDetails: {
      ...run.blockDetails,
      [snapshot.blockId]: {
        ...currentDetail,
        ...(snapshot.blockTitle ? { blockTitle: snapshot.blockTitle } : {}),
        progress: [...currentDetail.progress, snapshot.event].slice(
          -RALPH_BLOCK_PROGRESS_LIMIT,
        ),
      },
    },
  };
};

export const getRunEventToneClassName = (tone: RalphRunEventTone): string => {
  switch (tone) {
    case "danger":
      return "border-rose-400/30 bg-rose-500/10 text-rose-100";
    case "warning":
      return "border-amber-400/30 bg-amber-500/10 text-amber-100";
    case "success":
      return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
    case "info":
      return "border-sky-400/30 bg-sky-500/10 text-sky-100";
    case "neutral":
      return "border-slate-800 bg-slate-950 text-slate-300";
  }
};

export const getRalphProgressKindLabel = (
  event: RalphRunRecordBlockProgressEvent,
): string => {
  if (event.kind === "model-stream") {
    switch (event.streamKind) {
      case "reasoning":
        return "Reasoning";
      case "tool-call":
        return "Tool call";
      case "tool-result":
        return "Tool result";
      case "assistant":
        return "Assistant";
      case "status":
        return "Model status";
      default:
        return "Model stream";
    }
  }

  if (event.kind === "action-output") {
    return event.stream === "stderr" ? "stderr" : "stdout";
  }

  if (event.kind === "timeline") {
    return event.phase ? titleFromId(event.phase) : "Event";
  }

  return "Message";
};

export const getRalphProgressToneClassName = (
  event: RalphRunRecordBlockProgressEvent,
): string => {
  if (event.tone) {
    return getRunEventToneClassName(event.tone);
  }

  if (event.kind === "model-stream") {
    if (event.streamKind === "reasoning") {
      return "border-violet-400/30 bg-violet-500/10 text-violet-100";
    }

    if (event.streamKind === "tool-call" || event.streamKind === "tool-result") {
      return "border-sky-400/30 bg-sky-500/10 text-sky-100";
    }
  }

  if (event.kind === "action-output" && event.stream === "stderr") {
    return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  }

  return "border-slate-800 bg-slate-950 text-slate-300";
};

export const formatRalphProgressTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
};

const getActiveBlockDetailTimestamp = (
  detail: ActiveRalphRunBlockDetail,
): number => {
  const progressTimestamp = detail.progress.at(-1)?.timestamp;
  const progressMs = progressTimestamp
    ? Date.parse(progressTimestamp)
    : Number.NaN;
  const eventMs = detail.events.at(-1)?.timestamp ?? Number.NaN;

  return Math.max(
    Number.isFinite(progressMs) ? progressMs : 0,
    Number.isFinite(eventMs) ? eventMs : 0,
  );
};

export const getSortedActiveBlockDetails = (
  run: ActiveRalphRun,
): ActiveRalphRunBlockDetail[] => {
  return Object.values(run.blockDetails).sort(
    (left, right) =>
      getActiveBlockDetailTimestamp(right) -
      getActiveBlockDetailTimestamp(left),
  );
};
