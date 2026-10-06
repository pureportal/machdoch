import type {
  SchedulerCreateJobInput,
  SchedulerJobActionResult,
  SchedulerListJobsResult,
  SchedulerListRunsResult,
  SchedulerRalphFlowInput,
  SchedulerRalphReadinessResult,
  SchedulerRetryResult,
  SchedulerRunActionResult,
  SchedulerRunDueResult,
  SchedulerTriggerResult,
} from "@machdoch/fleet-protocol/scheduler-contract";

type Workspace = string | null | undefined;
type Reasoning = NonNullable<SchedulerCreateJobInput["reasoning"]>;
type Provider = NonNullable<SchedulerCreateJobInput["provider"]>;

export interface SchedulerRuntime {
  listSchedulerJobs(workspace: Workspace): Promise<SchedulerListJobsResult>;
  listSchedulerRuns(
    workspace: Workspace,
    jobId?: string | null,
  ): Promise<SchedulerListRunsResult>;
  createSchedulerJob(
    workspace: Workspace,
    input: SchedulerCreateJobInput,
  ): Promise<SchedulerJobActionResult>;
  pauseSchedulerJob(
    workspace: Workspace,
    jobId: string,
  ): Promise<SchedulerJobActionResult>;
  resumeSchedulerJob(
    workspace: Workspace,
    jobId: string,
  ): Promise<SchedulerJobActionResult>;
  deleteSchedulerJob(
    workspace: Workspace,
    jobId: string,
  ): Promise<SchedulerJobActionResult>;
  triggerSchedulerJob(
    workspace: Workspace,
    jobId: string,
  ): Promise<SchedulerTriggerResult>;
  retrySchedulerRun(
    workspace: Workspace,
    runId: string,
  ): Promise<SchedulerRetryResult>;
  cancelSchedulerRun(
    workspace: Workspace,
    runId: string,
  ): Promise<SchedulerRunActionResult>;
  runDueSchedulerJobs(workspace: Workspace): Promise<SchedulerRunDueResult>;
  inspectSchedulerRalphFlow(
    workspace: Workspace,
    flow: SchedulerRalphFlowInput,
  ): Promise<SchedulerRalphReadinessResult>;
  listRalphFlows(
    workspace: Workspace,
    scope: "workspace" | "user",
  ): Promise<{
    flows: Array<{ id: string; name: string; alias?: string }>;
  }>;
  subscribeToSettingsImport?(
    listener: (event: { categories: string[] }) => void,
  ): Promise<() => void>;
  getReasoningModesForProvider(
    provider: Provider | null,
    model: string | null,
  ): readonly Reasoning[];
  normalizeReasoningModeForProvider(
    reasoning: Reasoning,
    provider: Provider | null,
    model: string | null,
  ): Reasoning;
  reasoningLabels: Record<Reasoning, string>;
}
