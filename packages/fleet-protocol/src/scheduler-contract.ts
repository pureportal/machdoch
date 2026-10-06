import type { ProductShell } from "./index.js";

export type SchedulerJobStatus = "active" | "paused" | "completed" | "deleted";

export type SchedulerRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "expired"
  | "skipped";

export type SchedulerRunSource =
  | "schedule"
  | "manual"
  | "manual-retry"
  | "event";

export type SchedulerMissedRunPolicy =
  | "skip"
  | "enqueue-latest"
  | "enqueue-all";

export type SchedulerScheduleSummary =
  | {
      type: "cron";
      expression: string;
      timezone: string;
    }
  | {
      type: "interval";
      intervalMs: number;
      anchorAt: number;
    }
  | {
      type: "delay";
      runAt: number;
    };

export type SchedulerCreateScheduleInput =
  | {
      type: "cron";
      expression: string;
      timezone?: string;
    }
  | {
      type: "interval";
      intervalMs: number;
    }
  | {
      type: "delay";
      delayMs?: number;
      runAt?: number;
    };

export interface SchedulerTriggerSummary {
  id: string;
  kind: string;
  enabled: boolean;
  name?: string;
  eventType?: string;
  schedule?: SchedulerScheduleSummary;
  nextRunAt?: number;
  filters?: Record<string, unknown>;
  recoveryFilters?: Record<string, unknown>;
  firingMode?: "event" | "state";
  cooldownMs?: number;
  repeatIntervalMs?: number;
  debounceMs?: number;
  dedupeKeyTemplate?: string;
  maxEventsPerWindow?: {
    maxEvents: number;
    windowMs: number;
  };
}

export interface SchedulerCreateTriggerInput {
  id?: string;
  kind: string;
  enabled?: boolean;
  name?: string;
  eventType?: string;
  schedule?: SchedulerCreateScheduleInput;
  filters?: Record<string, unknown>;
  recoveryFilters?: Record<string, unknown>;
  firingMode?: "event" | "state";
  cooldownMs?: number;
  repeatIntervalMs?: number;
  debounceMs?: number;
  dedupeKeyTemplate?: string;
  maxEventsPerWindow?: {
    maxEvents: number;
    windowMs: number;
  };
}

export interface SchedulerRetrySummary {
  maxAttempts: number;
  factor: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  randomize: boolean;
}

export interface SchedulerQueueSummary {
  concurrencyKey: string;
  concurrencyLimit: number;
}

export interface SchedulerJobSummary {
  id: string;
  name: string;
  status: SchedulerJobStatus;
  schedule: SchedulerScheduleSummary | null;
  triggers: SchedulerTriggerSummary[];
  triggerLabel: string;
  targetType: "prompt" | "ralph-flow";
  workspaceRoot: string;
  prompt: string;
  ralphFlow: SchedulerRalphFlowSummary | null;
  nextRunAt: number | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  queue: SchedulerQueueSummary;
  retry: SchedulerRetrySummary;
  dedupeKey: string | null;
  ttlMs: number | null;
  maxDurationMs: number | null;
}

export interface SchedulerRunSummary {
  id: string;
  jobId: string;
  source: SchedulerRunSource;
  status: SchedulerRunStatus;
  scheduledFor: number;
  enqueuedAt: number;
  updatedAt: number;
  attempt: number;
  maxAttempts: number;
  queueKey: string;
  startedAt: number | null;
  finishedAt: number | null;
  nextAttemptAt: number | null;
  expiresAt: number | null;
  error: string | null;
  summary: string | null;
}

export interface SchedulerContextPackInput {
  name: string;
  instructions?: string;
  prompt?: string;
  contextPaths?: string[];
  variableValues?: Record<string, string>;
}

export interface SchedulerRalphFlowPermissionsInput {
  allowedRoots: string[];
  allowCommands: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  allowMcpTools: boolean;
}

export interface SchedulerRalphFlowInput {
  scope?: "workspace" | "user";
  id: string;
  params?: Record<string, string>;
  maxTransitions?: number;
  runLogScope?: "workspace" | "user";
  executionProfile?: "unattended";
  resumePolicy?: "never" | "recoverable";
  permissions: SchedulerRalphFlowPermissionsInput;
}

export interface SchedulerRalphFlowSummary extends SchedulerRalphFlowInput {
  scope: "workspace" | "user";
  params: Record<string, string>;
}

export interface SchedulerCreateJobInput {
  requestId?: string;
  name?: string;
  schedule?: SchedulerCreateScheduleInput;
  triggers?: SchedulerCreateTriggerInput[];
  targetType?: "prompt" | "ralph-flow";
  prompt?: string;
  promptFile?: string;
  ralphFlow?: SchedulerRalphFlowInput;
  contextPaths?: string[];
  imagePaths?: string[];
  contextPacks?: SchedulerContextPackInput[];
  macros?: string[];
  missedRunPolicy?: SchedulerMissedRunPolicy;
  missedRunGraceMs?: number;
  retryAttempts?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  retryFactor?: number;
  retryRandomize?: boolean;
  dedupeKey?: string;
  ttlMs?: number;
  maxDurationMs?: number;
  concurrencyKey?: string;
  concurrencyLimit?: number;
  historyLimit?: number;
  maxCatchUpRuns?: number;
  mode?: NonNullable<ProductShell["composer"]>["mode"];
  provider?:
    | "openai"
    | "anthropic"
    | "google"
    | "langdock"
    | "codex-cli"
    | "claude-cli"
    | "copilot-cli";
  model?: string;
  reasoning?: NonNullable<ProductShell["composer"]>["reasoning"];
}

export interface SchedulerListJobsResult {
  workspaceRoot: string;
  jobs: SchedulerJobSummary[];
}

export interface SchedulerListRunsResult {
  workspaceRoot: string;
  runs: SchedulerRunSummary[];
}

export interface SchedulerJobActionResult {
  job: SchedulerJobSummary;
}

export interface SchedulerRunActionResult {
  run: SchedulerRunSummary;
}

export interface SchedulerRunHandle {
  jobId: string;
  runId: string;
}

export interface SchedulerEnqueueSummary {
  handle: SchedulerRunHandle;
  run: SchedulerRunSummary;
  deduplicated: boolean;
}

export interface SchedulerRunDueResult {
  queued: SchedulerRunSummary[];
  runs: SchedulerRunSummary[];
}

export interface SchedulerRalphVariableReadinessSummary {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  value?: string;
  source: "parameter" | "default" | "missing";
}

export interface SchedulerRalphReadinessResult {
  ready: boolean;
  flowId: string;
  flowName?: string;
  flowFingerprint?: string;
  variables: SchedulerRalphVariableReadinessSummary[];
  autoResolvedHumanBlockIds: string[];
  blockingHumanBlockIds: string[];
  errors: string[];
  warnings: string[];
}

export interface SchedulerFleetRunResult {
  recovered: number;
  queued: number;
  runs: number;
  workspaces: Array<{
    workspaceRoot: string;
    recovered: number;
    queued: number;
    runs: number;
    error?: string;
  }>;
}

export interface SchedulerTriggerResult {
  queued: SchedulerEnqueueSummary;
  runs: SchedulerRunSummary[];
}

export interface SchedulerRetryResult {
  handle: SchedulerRunHandle;
  runs: SchedulerRunSummary[];
}

export interface SchedulerPromptDefinitionSummary {
  path: string;
  name: string;
  enabled: boolean;
  warnings: string[];
}

export interface SchedulerPromptSyncResult {
  workspaceRoot: string;
  discovered: SchedulerPromptDefinitionSummary[];
  syncedJobs: SchedulerJobSummary[];
  pausedJobs: SchedulerJobSummary[];
}
