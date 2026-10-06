import type { SchedulerRuntime } from "@machdoch/client-ui/scheduler";
import {
  cancelSchedulerRun,
  createSchedulerJob,
  deleteSchedulerJob,
  inspectSchedulerRalphFlow,
  listRalphFlows,
  listSchedulerJobs,
  listSchedulerRuns,
  pauseSchedulerJob,
  resumeSchedulerJob,
  retrySchedulerRun,
  runDueSchedulerJobs,
  triggerSchedulerJob,
} from "../runtime";
import { subscribeToSettingsImport } from "../settings-transfer";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
  REASONING_LABELS,
} from "../reasoning-options";

export const schedulerRuntime: SchedulerRuntime = {
  cancelSchedulerRun,
  createSchedulerJob,
  deleteSchedulerJob,
  inspectSchedulerRalphFlow,
  listRalphFlows,
  listSchedulerJobs,
  listSchedulerRuns,
  pauseSchedulerJob,
  resumeSchedulerJob,
  retrySchedulerRun,
  runDueSchedulerJobs,
  triggerSchedulerJob,
  subscribeToSettingsImport,
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
  reasoningLabels: REASONING_LABELS,
};
