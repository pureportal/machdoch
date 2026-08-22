import type { RalphGenerationEvent } from "../../../../core/ralph-generation.js";
import type { TaskExecutionProgress } from "../../../../core/types.js";
import {
  getProgressMetadataBoolean,
  getProgressMetadataNumber,
  getProgressMetadataString,
} from "./ralph-active-run-progress.helper";

export interface RalphGenerationActivityEvent {
  id: string;
  type: string;
  label: string;
  timestamp: number;
  detail?: string;
  round?: number;
  maxRounds?: number;
  actor?: string;
  provider?: string;
  model?: string;
  flowPath?: string;
  tempFlowPath?: string;
  validationValid?: boolean;
  validationErrorCount?: number;
  validationWarningCount?: number;
  validatorDecision?: string;
  blockCount?: number;
  edgeCount?: number;
}

export interface RalphGenerationActivityState {
  summary: string;
  activity: RalphGenerationActivityEvent[];
  currentRound?: number;
  maxRounds?: number;
  currentActor?: string;
  provider?: string;
  model?: string;
  flowPath?: string;
  tempFlowPath?: string;
  validationValid?: boolean;
  validationErrorCount?: number;
  validationWarningCount?: number;
  validatorDecision?: string;
  blockCount?: number;
  edgeCount?: number;
}

const RALPH_GENERATION_ACTIVITY_LIMIT = 80;

export const createGenerationActivityFromProgress = (
  progress: TaskExecutionProgress,
  timestamp: number,
): RalphGenerationActivityEvent | null => {
  const metadata = progress.timelineEvent?.metadata;
  const type = getProgressMetadataString(metadata, "ralphGenerationEventType");

  if (!type) {
    return null;
  }

  const label = progress.timelineEvent?.label || progress.message || type;
  const round = getProgressMetadataNumber(metadata, "ralphGenerationRound");
  const maxRounds = getProgressMetadataNumber(
    metadata,
    "ralphGenerationMaxRounds",
  );
  const actor = getProgressMetadataString(metadata, "ralphGenerationActor");
  const provider = progress.timelineEvent?.provider ?? undefined;
  const model = progress.timelineEvent?.model ?? undefined;
  const flowPath = getProgressMetadataString(
    metadata,
    "ralphGenerationFlowPath",
  );
  const tempFlowPath = getProgressMetadataString(
    metadata,
    "ralphGenerationTempFlowPath",
  );
  const validationValid = getProgressMetadataBoolean(
    metadata,
    "ralphGenerationValidationValid",
  );
  const validationErrorCount = getProgressMetadataNumber(
    metadata,
    "ralphGenerationValidationErrorCount",
  );
  const validationWarningCount = getProgressMetadataNumber(
    metadata,
    "ralphGenerationValidationWarningCount",
  );
  const validatorDecision = getProgressMetadataString(
    metadata,
    "ralphGenerationValidatorDecision",
  );
  const blockCount = getProgressMetadataNumber(
    metadata,
    "ralphGenerationBlockCount",
  );
  const edgeCount = getProgressMetadataNumber(
    metadata,
    "ralphGenerationEdgeCount",
  );

  return {
    id: `${timestamp}-${type}-${round ?? 0}-${label}`,
    type,
    label,
    timestamp,
    ...(progress.timelineEvent?.detail
      ? { detail: progress.timelineEvent.detail }
      : {}),
    ...(round !== undefined ? { round } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(actor ? { actor } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(flowPath ? { flowPath } : {}),
    ...(tempFlowPath ? { tempFlowPath } : {}),
    ...(validationValid !== undefined ? { validationValid } : {}),
    ...(validationErrorCount !== undefined ? { validationErrorCount } : {}),
    ...(validationWarningCount !== undefined ? { validationWarningCount } : {}),
    ...(validatorDecision ? { validatorDecision } : {}),
    ...(blockCount !== undefined ? { blockCount } : {}),
    ...(edgeCount !== undefined ? { edgeCount } : {}),
  };
};

export const createGenerationActivityFromResultEvent = (
  event: RalphGenerationEvent,
): RalphGenerationActivityEvent => {
  const timestamp = Date.parse(event.createdAt);

  return {
    id: `${event.createdAt}-${event.type}-${event.round ?? 0}-${event.message}`,
    type: event.type,
    label: event.message,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    ...(event.round !== undefined ? { round: event.round } : {}),
    ...(event.maxRounds !== undefined ? { maxRounds: event.maxRounds } : {}),
    ...(event.actor ? { actor: event.actor } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.flowPath ? { flowPath: event.flowPath } : {}),
    ...(event.generationFlowPath
      ? { tempFlowPath: event.generationFlowPath }
      : {}),
    ...(event.validationValid !== undefined
      ? { validationValid: event.validationValid }
      : {}),
    ...(event.validationErrorCount !== undefined
      ? { validationErrorCount: event.validationErrorCount }
      : {}),
    ...(event.validationWarningCount !== undefined
      ? { validationWarningCount: event.validationWarningCount }
      : {}),
    ...(event.validatorDecision
      ? { validatorDecision: event.validatorDecision }
      : {}),
    ...(event.blockCount !== undefined ? { blockCount: event.blockCount } : {}),
    ...(event.edgeCount !== undefined ? { edgeCount: event.edgeCount } : {}),
  };
};

export const appendGenerationActivity = (
  current: readonly RalphGenerationActivityEvent[],
  nextEvents: readonly RalphGenerationActivityEvent[],
): RalphGenerationActivityEvent[] => {
  if (nextEvents.length === 0) {
    return [...current];
  }

  const seen = new Set(current.map((event) => event.id));
  const merged = [...current];

  for (const event of nextEvents) {
    if (seen.has(event.id)) {
      continue;
    }

    seen.add(event.id);
    merged.push(event);
  }

  return merged
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-RALPH_GENERATION_ACTIVITY_LIMIT);
};

export const applyGenerationActivity = <
  T extends RalphGenerationActivityState,
>(
  job: T,
  event: RalphGenerationActivityEvent,
): T => {
  return {
    ...job,
    summary: event.label || job.summary,
    activity: appendGenerationActivity(job.activity, [event]),
    ...(event.round !== undefined ? { currentRound: event.round } : {}),
    ...(event.maxRounds !== undefined ? { maxRounds: event.maxRounds } : {}),
    ...(event.actor ? { currentActor: event.actor } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.flowPath ? { flowPath: event.flowPath } : {}),
    ...(event.tempFlowPath ? { tempFlowPath: event.tempFlowPath } : {}),
    ...(event.validationValid !== undefined
      ? { validationValid: event.validationValid }
      : {}),
    ...(event.validationErrorCount !== undefined
      ? { validationErrorCount: event.validationErrorCount }
      : {}),
    ...(event.validationWarningCount !== undefined
      ? { validationWarningCount: event.validationWarningCount }
      : {}),
    ...(event.validatorDecision
      ? { validatorDecision: event.validatorDecision }
      : {}),
    ...(event.blockCount !== undefined ? { blockCount: event.blockCount } : {}),
    ...(event.edgeCount !== undefined ? { edgeCount: event.edgeCount } : {}),
  };
};
