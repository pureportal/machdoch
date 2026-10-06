import { useMemo, useRef } from "react";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
  type CommandScope,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import type {
  SchedulerJobSummary,
  SchedulerRunSummary,
  SchedulerCreateJobInput,
} from "@machdoch/fleet-protocol/scheduler-contract";
import {
  terminalRunStatuses,
  type SchedulerFormState,
  type SchedulerPanelTab,
  type SchedulerRalphFlowOption,
  type SchedulerRalphReadinessView,
  type SchedulerReasoningFormValue,
} from "./scheduler-form-model";
import type { SchedulerRuntime } from "./scheduler-runtime";

interface SchedulerCommandState {
  commandScope: CommandScope;
  activeWorkspace: string | null;
  jobs: SchedulerJobSummary[];
  runs: SchedulerRunSummary[];
  selectedJobId: string | null;
  tab: SchedulerPanelTab;
  form: SchedulerFormState;
  busyAction: string | null;
  ralphFlowOptions: SchedulerRalphFlowOption[];
  ralphReadiness: SchedulerRalphReadinessView;
  reasoningOptions: readonly NonNullable<
    SchedulerCreateJobInput["reasoning"]
  >[];
  reasoningValue: SchedulerReasoningFormValue;
  refresh(): Promise<void>;
  runDue(): Promise<void>;
  createJob(): Promise<void>;
  toggleJobPaused(job: SchedulerJobSummary): void;
  triggerJob(job: SchedulerJobSummary): void;
  removeJob(job: SchedulerJobSummary): void;
  retryRun(run: SchedulerRunSummary): void;
  cancelRun(run: SchedulerRunSummary): void;
  setSelectedJobId(id: string | null): void;
  setTab(tab: SchedulerPanelTab): void;
  updateForm(patch: Partial<SchedulerFormState>): void;
  reasoningLabels: SchedulerRuntime["reasoningLabels"];
}

export function useSchedulerCommands(
  commandState: SchedulerCommandState,
): void {
  const stateRef = useRef(commandState);
  stateRef.current = commandState;
  const schedulerCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = commandState.commandScope;
    const state = () => stateRef.current;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    const workspaceAvailability = () =>
      !state().activeWorkspace
        ? { state: "disabled" as const, reason: "Select a workspace first." }
        : state().busyAction
          ? {
              state: "disabled" as const,
              reason: "A scheduler action is in progress.",
            }
          : { state: "enabled" as const };
    return asPaletteCommands([
      {
        id: "scheduler.tab.select",
        title: "Choose scheduler view",
        group: "Scheduler",
        scope,
        children: () => ({
          id: "scheduler.tab.select.page",
          title: "Choose scheduler view",
          searchPlaceholder: "Search views",
          numericSelection: true,
          groups: [
            {
              id: "views",
              items: (["jobs", "runs"] as const).map((tab, index) => ({
                id: tab,
                title: tab === "jobs" ? "Jobs" : "Runs",
                current: state().tab === tab,
                numericKey: numericKey(index),
                execute: () => state().setTab(tab),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.refresh",
        title: "Refresh scheduler",
        group: "Scheduler",
        scope,
        availability: workspaceAvailability,
        execute: () => void state().refresh(),
      },
      {
        id: "scheduler.run-due",
        title: "Run due scheduler jobs",
        group: "Scheduler",
        scope,
        availability: workspaceAvailability,
        execute: () => void state().runDue(),
      },
      {
        id: "scheduler.job.select",
        title: "Show scheduler job runs",
        group: "Scheduler",
        scope,
        availability: () =>
          state().jobs.length
            ? { state: "enabled" }
            : { state: "disabled", reason: "No scheduler jobs." },
        children: () => ({
          id: "scheduler.job.select.page",
          title: "Show scheduler job runs",
          searchPlaceholder: "Search jobs",
          groups: [
            {
              id: "jobs",
              items: state().jobs.map((job) => ({
                id: job.id,
                title: job.name,
                keywords: [job.id, job.status, job.targetType],
                current: state().selectedJobId === job.id,
                execute: () => {
                  state().setSelectedJobId(job.id);
                  state().setTab("runs");
                },
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.run-filter.clear",
        title: "Show all scheduler runs",
        group: "Scheduler",
        scope,
        availability: () =>
          state().selectedJobId ? { state: "enabled" } : { state: "hidden" },
        execute: () => state().setSelectedJobId(null),
      },
      {
        id: "scheduler.job.pause-toggle",
        title: "Pause or resume scheduler job",
        group: "Scheduler",
        scope,
        availability: () => {
          const available = workspaceAvailability();
          if (available.state !== "enabled") return available;
          return state().jobs.length
            ? available
            : { state: "disabled", reason: "No scheduler jobs." };
        },
        children: () => ({
          id: "scheduler.job.pause-toggle.page",
          title: "Pause or resume scheduler job",
          searchPlaceholder: "Search jobs",
          groups: [
            {
              id: "jobs",
              items: state().jobs.map((job) => ({
                id: job.id,
                title: `${job.status === "paused" ? "Resume" : "Pause"} ${job.name}`,
                keywords: [job.id, job.status],
                current: job.status === "paused",
                execute: () => state().toggleJobPaused(job),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.job.trigger",
        title: "Run scheduler job now",
        group: "Scheduler",
        scope,
        availability: workspaceAvailability,
        children: () => ({
          id: "scheduler.job.trigger.page",
          title: "Run scheduler job now",
          searchPlaceholder: "Search jobs",
          groups: [
            {
              id: "jobs",
              items: state().jobs.map((job) => ({
                id: job.id,
                title: job.name,
                keywords: [job.id, job.status],
                execute: () => state().triggerJob(job),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.job.delete",
        title: "Delete scheduler job",
        group: "Scheduler",
        scope,
        availability: workspaceAvailability,
        children: () => ({
          id: "scheduler.job.delete.page",
          title: "Delete scheduler job",
          searchPlaceholder: "Search jobs",
          groups: [
            {
              id: "jobs",
              items: state().jobs.map((job) => ({
                id: job.id,
                title: job.name,
                keywords: [job.id, job.status],
                execute: () => state().removeJob(job),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.run.retry",
        title: "Retry scheduler run",
        group: "Scheduler",
        scope,
        availability: workspaceAvailability,
        children: () => ({
          id: "scheduler.run.retry.page",
          title: "Retry scheduler run",
          searchPlaceholder: "Search runs",
          groups: [
            {
              id: "runs",
              items: state().runs.map((run) => ({
                id: run.id,
                title: run.id,
                keywords: [run.jobId, run.status],
                availability:
                  run.status !== "succeeded" &&
                  terminalRunStatuses.has(run.status)
                    ? { state: "enabled" }
                    : {
                        state: "disabled",
                        reason: "This run cannot be retried.",
                      },
                execute: () => state().retryRun(run),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.run.cancel",
        title: "Cancel scheduler run",
        group: "Scheduler",
        scope,
        availability: workspaceAvailability,
        children: () => ({
          id: "scheduler.run.cancel.page",
          title: "Cancel scheduler run",
          searchPlaceholder: "Search runs",
          groups: [
            {
              id: "runs",
              items: state().runs.map((run) => ({
                id: run.id,
                title: run.id,
                keywords: [run.jobId, run.status],
                availability: terminalRunStatuses.has(run.status)
                  ? { state: "disabled", reason: "This run has finished." }
                  : { state: "enabled" },
                execute: () => state().cancelRun(run),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.job.create",
        title: "Create scheduler job",
        group: "Scheduler",
        scope,
        availability: () => {
          const available = workspaceAvailability();
          if (available.state !== "enabled") return available;
          return state().form.targetType === "ralph-flow" &&
            (!state().ralphReadiness.ready || state().ralphReadiness.loading)
            ? {
                state: "disabled",
                reason: "The selected RALPH flow is not ready.",
              }
            : available;
        },
        execute: () => void state().createJob(),
      },
      {
        id: "scheduler.target.select",
        title: "Choose scheduler target",
        group: "Scheduler",
        scope,
        children: () => ({
          id: "scheduler.target.select.page",
          title: "Choose scheduler target",
          searchPlaceholder: "Search targets",
          numericSelection: true,
          groups: [
            {
              id: "targets",
              items: (["prompt", "ralph-flow"] as const).map(
                (targetType, index) => ({
                  id: targetType,
                  title: targetType === "prompt" ? "Prompt" : "RALPH Flow",
                  current: state().form.targetType === targetType,
                  numericKey: numericKey(index),
                  execute: () =>
                    state().updateForm({
                      targetType,
                      ...(targetType === "ralph-flow" &&
                      state().form.ralphUnattended
                        ? {
                            ralphAllowCommands: true,
                            ralphAllowWrites: true,
                            ralphAllowNetwork: true,
                            ralphAllowMcpTools: true,
                          }
                        : {}),
                    }),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "scheduler.ralph-flow.select",
        title: "Choose scheduled RALPH flow",
        group: "Scheduler",
        scope,
        availability: () =>
          state().form.targetType === "ralph-flow"
            ? state().ralphFlowOptions.length
              ? { state: "enabled" }
              : { state: "disabled", reason: "No RALPH flows are available." }
            : { state: "hidden" },
        children: () => ({
          id: "scheduler.ralph-flow.select.page",
          title: "Choose scheduled RALPH flow",
          searchPlaceholder: "Search RALPH flows",
          groups: [
            {
              id: "flows",
              items: state().ralphFlowOptions.map((flow) => ({
                id: flow.id,
                title: flow.name,
                keywords: [flow.id, flow.alias ?? ""],
                current: state().form.ralphFlowId === (flow.alias ?? flow.id),
                execute: () =>
                  state().updateForm({ ralphFlowId: flow.alias ?? flow.id }),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.schedule.select",
        title: "Choose scheduler schedule",
        group: "Scheduler",
        scope,
        children: () => ({
          id: "scheduler.schedule.select.page",
          title: "Choose scheduler schedule",
          searchPlaceholder: "Search schedules",
          numericSelection: true,
          groups: [
            {
              id: "schedules",
              items: (["cron", "interval", "delay", "event"] as const).map(
                (scheduleType, index) => ({
                  id: scheduleType,
                  title:
                    scheduleType === "cron"
                      ? "Cron"
                      : scheduleType === "interval"
                        ? "Interval"
                        : scheduleType === "delay"
                          ? "Delay"
                          : "Event",
                  current: state().form.scheduleType === scheduleType,
                  numericKey: numericKey(index),
                  execute: () =>
                    state().updateForm({
                      scheduleType,
                      ...(scheduleType === "event"
                        ? { triggerEnabled: true }
                        : {}),
                    }),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "scheduler.missed-run-policy.select",
        title: "Choose missed-run policy",
        group: "Scheduler",
        scope,
        children: () => ({
          id: "scheduler.missed-run-policy.select.page",
          title: "Choose missed-run policy",
          searchPlaceholder: "Search policies",
          numericSelection: true,
          groups: [
            {
              id: "policies",
              items: (
                [
                  ["enqueue-latest", "Enqueue latest"],
                  ["enqueue-all", "Enqueue all"],
                  ["skip", "Skip missed runs"],
                ] as const
              ).map(([missedRunPolicy, title], index) => ({
                id: missedRunPolicy,
                title,
                current: state().form.missedRunPolicy === missedRunPolicy,
                numericKey: numericKey(index),
                execute: () => state().updateForm({ missedRunPolicy }),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.mode.select",
        title: "Choose scheduler mode",
        group: "Scheduler",
        scope,
        availability: () =>
          state().form.targetType === "prompt"
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "scheduler.mode.select.page",
          title: "Choose scheduler mode",
          searchPlaceholder: "Search modes",
          numericSelection: true,
          groups: [
            {
              id: "modes",
              items: (
                [
                  ["", "Workspace default"],
                  ["ask", "Ask"],
                  ["machdoch", "Machdoch"],
                ] as const
              ).map(([mode, title], index) => ({
                id: mode || "default",
                title,
                current: state().form.mode === mode,
                numericKey: numericKey(index),
                execute: () => state().updateForm({ mode }),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.provider.select",
        title: "Choose scheduler provider",
        group: "Scheduler",
        scope,
        availability: () =>
          state().form.targetType === "prompt"
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "scheduler.provider.select.page",
          title: "Choose scheduler provider",
          searchPlaceholder: "Search providers",
          numericSelection: true,
          groups: [
            {
              id: "providers",
              items: (
                [
                  ["", "Workspace default"],
                  ["openai", "OpenAI"],
                  ["anthropic", "Anthropic"],
                  ["google", "Google"],
                ] as const
              ).map(([provider, title], index) => ({
                id: provider || "default",
                title,
                current: state().form.provider === provider,
                numericKey: numericKey(index),
                execute: () => state().updateForm({ provider }),
              })),
            },
          ],
        }),
      },
      {
        id: "scheduler.reasoning.select",
        title: "Choose scheduler reasoning",
        group: "Scheduler",
        scope,
        availability: () =>
          state().form.targetType === "prompt"
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "scheduler.reasoning.select.page",
          title: "Choose scheduler reasoning",
          searchPlaceholder: "Search reasoning modes",
          numericSelection: true,
          groups: [
            {
              id: "reasoning",
              items: (["", ...state().reasoningOptions] as const).map(
                (reasoning, index) => ({
                  id: reasoning || "default",
                  title: reasoning
                    ? state().reasoningLabels[reasoning]
                    : "Workspace default",
                  current: state().reasoningValue === reasoning,
                  numericKey: numericKey(index),
                  execute: () => state().updateForm({ reasoning }),
                }),
              ),
            },
          ],
        }),
      },
    ]);
  }, [commandState.commandScope]);
  useOptionalRegisterCommands(schedulerCommands);
}
