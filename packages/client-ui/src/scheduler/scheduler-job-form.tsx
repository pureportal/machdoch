import { getStatusBadgeClassName } from "./scheduler-display";
import { Loader2, Plus } from "lucide-react";
import { type JSX } from "react";
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";

import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  SchedulerCreateJobInput,
  SchedulerMissedRunPolicy,
} from "@machdoch/fleet-protocol/scheduler-contract";
import type { SchedulerRuntime } from "./scheduler-runtime";

import {
  type SchedulerFormState,
  type SchedulerRalphFlowOption,
  type SchedulerRalphReadinessView,
  type SchedulerRalphVariable,
  type SchedulerTriggerKind,
  type SchedulerReasoningFormValue,
  triggerKindOptions,
  defaultEventTypeByKind,
  getSchedulerRalphParamEditorValue,
} from "./scheduler-form-model";

interface SchedulerJobFormProps {
  activeWorkspace: string | null;
  form: SchedulerFormState;
  busyAction: string | null;
  ralphReadiness: SchedulerRalphReadinessView;
  ralphFlowOptions: SchedulerRalphFlowOption[];
  ralphVariables: SchedulerRalphVariable[];
  reasoningOptions: readonly NonNullable<
    SchedulerCreateJobInput["reasoning"]
  >[];
  reasoningValue: SchedulerReasoningFormValue;
  reasoningLabels: SchedulerRuntime["reasoningLabels"];
  normalizeReasoningModeForProvider: SchedulerRuntime["normalizeReasoningModeForProvider"];
  updateForm: (patch: Partial<SchedulerFormState>) => void;
  updateRalphParam: (name: string, value: string) => void;
  createJob: () => Promise<void>;
}

export function SchedulerJobForm({
  activeWorkspace,
  form,
  busyAction,
  ralphReadiness,
  ralphFlowOptions,
  ralphVariables,
  reasoningOptions,
  reasoningValue,
  reasoningLabels: REASONING_LABELS,
  normalizeReasoningModeForProvider,
  updateForm,
  updateRalphParam,
  createJob,
}: SchedulerJobFormProps): JSX.Element {
  return (
    <aside className="min-h-0 overflow-y-auto border-t border-slate-800 bg-slate-950/80 px-5 py-5 lg:border-l lg:border-t-0">
      <SubmitShortcut asChild>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !activeWorkspace ||
              busyAction ||
              (form.targetType === "ralph-flow" &&
                (!ralphReadiness.ready || ralphReadiness.loading))
            )
              return;
            void createJob();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <Plus className="h-4 w-4 text-sky-300" />
              Create Job
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={
                Boolean(busyAction) ||
                !activeWorkspace ||
                (form.targetType === "ralph-flow" &&
                  (!ralphReadiness.ready || ralphReadiness.loading))
              }
              {...SUBMIT_SHORTCUT_ACTION_PROPS}
              className="h-8 rounded-lg bg-sky-500 px-3 text-xs text-white hover:bg-sky-400"
            >
              {busyAction === "create" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create
            </Button>
          </div>

          <div className="grid gap-2">
            <label
              className="text-xs font-medium text-slate-400"
              htmlFor="scheduler-name"
            >
              Name
            </label>
            <Input
              id="scheduler-name"
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600"
              placeholder="Workspace sweep"
            />
          </div>

          <div className="grid gap-2">
            <div className="text-xs font-medium text-slate-400">Target</div>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
              {(["prompt", "ralph-flow"] as const).map((targetType) => (
                <Button
                  key={targetType}
                  type="button"
                  variant={
                    form.targetType === targetType ? "secondary" : "ghost"
                  }
                  size="sm"
                  onClick={() =>
                    updateForm({
                      targetType,
                      ...(targetType === "ralph-flow" && form.ralphUnattended
                        ? {
                            ralphAllowCommands: true,
                            ralphAllowWrites: true,
                            ralphAllowNetwork: true,
                            ralphAllowMcpTools: true,
                          }
                        : {}),
                    })
                  }
                  className={cn(
                    "h-8 rounded-md text-xs capitalize",
                    form.targetType === targetType
                      ? "bg-slate-700 text-white hover:bg-slate-700"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                  )}
                >
                  {targetType === "prompt" ? "Prompt" : "RALPH Flow"}
                </Button>
              ))}
            </div>
          </div>

          {form.targetType === "prompt" ? (
            <div className="grid gap-2">
              <label
                className="text-xs font-medium text-slate-400"
                htmlFor="scheduler-prompt"
              >
                Prompt
              </label>
              <Textarea
                id="scheduler-prompt"
                value={form.prompt}
                rows={4}
                onChange={(event) => updateForm({ prompt: event.target.value })}
                className="max-h-40 min-h-24 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600"
                placeholder="/daily-review"
              />
            </div>
          ) : (
            <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
              <div className="grid gap-2">
                <label
                  className="text-xs font-medium text-slate-400"
                  htmlFor="scheduler-ralph-flow"
                >
                  RALPH Flow ID
                </label>
                <Input
                  id="scheduler-ralph-flow"
                  list="scheduler-ralph-flow-options"
                  value={form.ralphFlowId}
                  onChange={(event) =>
                    updateForm({ ralphFlowId: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600"
                  placeholder="security-analysis"
                />
                <datalist id="scheduler-ralph-flow-options">
                  {ralphFlowOptions.map((flowOption) => (
                    <option
                      key={flowOption.id}
                      value={flowOption.alias ?? flowOption.id}
                    >
                      {flowOption.name}
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label
                    className="text-xs font-medium text-slate-400"
                    htmlFor="scheduler-ralph-scope"
                  >
                    Flow Scope
                  </label>
                  <select
                    id="scheduler-ralph-scope"
                    value={form.ralphFlowScope}
                    onChange={(event) =>
                      updateForm({
                        ralphFlowScope: event.target.value as
                          | "workspace"
                          | "user",
                      })
                    }
                    className="h-9 rounded-lg border border-slate-800 bg-slate-900/70 px-3 text-sm text-slate-100"
                  >
                    <option value="workspace">Workspace</option>
                    <option value="user">User</option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <label
                    className="text-xs font-medium text-slate-400"
                    htmlFor="scheduler-ralph-log-scope"
                  >
                    Log Scope
                  </label>
                  <select
                    id="scheduler-ralph-log-scope"
                    value={form.ralphRunLogScope}
                    onChange={(event) =>
                      updateForm({
                        ralphRunLogScope: event.target.value as
                          | "workspace"
                          | "user",
                      })
                    }
                    className="h-9 rounded-lg border border-slate-800 bg-slate-900/70 px-3 text-sm text-slate-100"
                  >
                    <option value="workspace">Workspace</option>
                    <option value="user">User</option>
                  </select>
                </div>
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-slate-400">
                    Flow readiness
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      ralphReadiness.loading
                        ? getStatusBadgeClassName("running")
                        : ralphReadiness.ready
                          ? getStatusBadgeClassName("succeeded")
                          : getStatusBadgeClassName("failed")
                    }
                  >
                    {ralphReadiness.loading
                      ? "checking"
                      : ralphReadiness.ready
                        ? "unattended ready"
                        : "not ready"}
                  </Badge>
                </div>
                {ralphReadiness.errors.length > 0 ? (
                  <div className="rounded-md border border-rose-500/25 bg-rose-500/10 px-2.5 py-2 text-[11px] leading-4 text-rose-100">
                    {ralphReadiness.errors.join(" ")}
                  </div>
                ) : null}
                {ralphReadiness.warnings.length > 0 ? (
                  <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-4 text-amber-100">
                    {ralphReadiness.warnings.join(" ")}
                  </div>
                ) : null}
              </div>
              {ralphVariables.length > 0 ? (
                <div className="grid gap-3 rounded-md border border-slate-800 bg-slate-950/45 p-2.5">
                  <div className="text-xs font-medium text-slate-300">
                    Typed parameters
                  </div>
                  {ralphVariables.map((variable) => {
                    const value = getSchedulerRalphParamEditorValue(
                      form.ralphParams,
                      variable.name,
                    );

                    return (
                      <label key={variable.name} className="grid gap-1.5">
                        <span className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                          <span>
                            {variable.name}
                            {variable.required ? " *" : ""}
                          </span>
                          <code className="text-[10px] text-slate-600">
                            {variable.type}
                          </code>
                        </span>
                        {variable.type === "boolean" ? (
                          <select
                            value={value}
                            onChange={(event) =>
                              updateRalphParam(
                                variable.name,
                                event.target.value,
                              )
                            }
                            className="h-8 rounded-md border border-slate-800 bg-slate-900 px-2 text-xs text-slate-100"
                          >
                            <option value="">Use default</option>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <Input
                            type={
                              variable.type === "number" ? "number" : "text"
                            }
                            value={value}
                            onChange={(event) =>
                              updateRalphParam(
                                variable.name,
                                event.target.value,
                              )
                            }
                            className="h-8 rounded-md border-slate-800 bg-slate-900 text-xs text-slate-100"
                            placeholder={variable.default ?? variable.name}
                          />
                        )}
                        {variable.default !== undefined ? (
                          <span className="text-[10px] text-slate-600">
                            Default: {variable.default || "(empty)"}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              ) : null}
              <div className="grid gap-2">
                <label
                  className="text-xs font-medium text-slate-400"
                  htmlFor="scheduler-ralph-params"
                >
                  Params (advanced name=value)
                </label>
                <Textarea
                  id="scheduler-ralph-params"
                  value={form.ralphParams}
                  rows={3}
                  onChange={(event) =>
                    updateForm({ ralphParams: event.target.value })
                  }
                  className="max-h-32 min-h-20 rounded-lg border-slate-800 bg-slate-900/70 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  placeholder={"path=src\nseverity=high"}
                />
              </div>
              <div className="grid gap-2">
                <label
                  className="text-xs font-medium text-slate-400"
                  htmlFor="scheduler-ralph-max-transitions"
                >
                  Max Transitions
                </label>
                <Input
                  id="scheduler-ralph-max-transitions"
                  value={form.ralphMaxTransitions}
                  onChange={(event) =>
                    updateForm({
                      ralphMaxTransitions: event.target.value,
                    })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                />
              </div>
              <div className="grid gap-2">
                <label
                  className="text-xs font-medium text-slate-400"
                  htmlFor="scheduler-ralph-roots"
                >
                  Allowed Roots
                </label>
                <Textarea
                  id="scheduler-ralph-roots"
                  value={form.ralphAllowedRoots}
                  rows={2}
                  onChange={(event) =>
                    updateForm({ ralphAllowedRoots: event.target.value })
                  }
                  className="max-h-28 min-h-16 rounded-lg border-slate-800 bg-slate-900/70 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  placeholder={activeWorkspace ?? "C:/workspace"}
                />
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium text-slate-300">
                      Unattended execution
                    </div>
                    <div className="mt-0.5 text-[11px] leading-4 text-slate-500">
                      Run agent blocks with every runtime capability and no
                      approval pause.
                    </div>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-xs font-medium text-emerald-100">
                    <input
                      type="checkbox"
                      aria-label="Run RALPH unattended"
                      checked={form.ralphUnattended}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        updateForm({
                          ralphUnattended: enabled,
                          ralphAllowCommands: enabled,
                          ralphAllowWrites: enabled,
                          ralphAllowNetwork: enabled,
                          ralphAllowMcpTools: enabled,
                        });
                      }}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-900"
                    />
                    Autonomous
                  </label>
                </div>
                <div className="text-xs font-medium text-slate-400">
                  Capabilities
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
                  {(
                    [
                      ["ralphAllowCommands", "Commands"],
                      ["ralphAllowWrites", "Writes"],
                      ["ralphAllowNetwork", "Network"],
                      ["ralphAllowMcpTools", "MCP Tools"],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/50 px-2 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(form[key as keyof SchedulerFormState])}
                        onChange={(event) =>
                          updateForm({
                            [key]: event.target.checked,
                            ...(!event.target.checked
                              ? { ralphUnattended: false }
                              : {}),
                          } as Partial<SchedulerFormState>)
                        }
                        className="h-4 w-4 rounded border-slate-700 bg-slate-900"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <div className="text-xs font-medium text-slate-400">Schedule</div>
            <div className="grid grid-cols-4 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
              {(["cron", "interval", "delay", "event"] as const).map((type) => (
                <Button
                  key={type}
                  type="button"
                  variant={form.scheduleType === type ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() =>
                    updateForm({
                      scheduleType: type,
                      ...(type === "event" ? { triggerEnabled: true } : {}),
                    })
                  }
                  className={cn(
                    "h-8 rounded-md px-2 text-xs capitalize",
                    form.scheduleType === type
                      ? "bg-slate-700 text-white hover:bg-slate-700"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                  )}
                >
                  {type}
                </Button>
              ))}
            </div>

            {form.scheduleType === "cron" ? (
              <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Cron Expression</span>
                  <Input
                    value={form.cron}
                    onChange={(event) =>
                      updateForm({ cron: event.target.value })
                    }
                    className="h-9 rounded-lg border-slate-800 bg-slate-900/70 font-mono text-sm text-slate-100"
                  />
                </label>
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Timezone</span>
                  <Input
                    value={form.timezone}
                    onChange={(event) =>
                      updateForm({ timezone: event.target.value })
                    }
                    className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                  />
                </label>
              </div>
            ) : null}

            {form.scheduleType === "interval" ? (
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Interval ms</span>
                <Input
                  type="number"
                  min={1}
                  value={form.intervalMs}
                  onChange={(event) =>
                    updateForm({ intervalMs: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                />
              </label>
            ) : null}

            {form.scheduleType === "delay" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Delay ms</span>
                  <Input
                    type="number"
                    min={1}
                    value={form.delayMs}
                    onChange={(event) =>
                      updateForm({ delayMs: event.target.value })
                    }
                    className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                  />
                </label>
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Run At</span>
                  <Input
                    type="datetime-local"
                    value={form.runAtLocal}
                    onChange={(event) =>
                      updateForm({ runAtLocal: event.target.value })
                    }
                    className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                  />
                </label>
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-slate-300">
                Event Trigger
              </div>
              <label className="flex items-center gap-2 text-[11px] font-medium text-slate-500">
                <input
                  type="checkbox"
                  checked={form.triggerEnabled || form.scheduleType === "event"}
                  disabled={form.scheduleType === "event"}
                  onChange={(event) =>
                    updateForm({ triggerEnabled: event.target.checked })
                  }
                  className="h-4 w-4 accent-sky-500"
                />
                Enabled
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Trigger Kind</span>
                <select
                  value={form.triggerKind}
                  onChange={(event) => {
                    const nextKind = event.target.value as SchedulerTriggerKind;
                    const currentDefault =
                      defaultEventTypeByKind[form.triggerKind];

                    updateForm({
                      triggerKind: nextKind,
                      ...(form.triggerEventType === currentDefault
                        ? {
                            triggerEventType: defaultEventTypeByKind[nextKind],
                          }
                        : {}),
                    });
                  }}
                  className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                >
                  {triggerKindOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Event Type</span>
                <Input
                  value={form.triggerEventType}
                  onChange={(event) =>
                    updateForm({ triggerEventType: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="system.disk-threshold"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Firing Mode</span>
                <select
                  value={form.triggerFiringMode}
                  onChange={(event) =>
                    updateForm({
                      triggerFiringMode: event.target.value as
                        | "event"
                        | "state",
                    })
                  }
                  className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                >
                  <option value="event">Event</option>
                  <option value="state">State Threshold</option>
                </select>
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Dedupe Template</span>
                <Input
                  value={form.triggerDedupeKeyTemplate}
                  onChange={(event) =>
                    updateForm({
                      triggerDedupeKeyTemplate: event.target.value,
                    })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="disk:{payload.path}"
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Activation Filters</span>
                <Textarea
                  value={form.triggerFilters}
                  rows={2}
                  onChange={(event) =>
                    updateForm({ triggerFilters: event.target.value })
                  }
                  className="max-h-28 rounded-lg border-slate-800 bg-slate-950 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  placeholder="payload.usedPercent>=90"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Recovery Filters</span>
                <Textarea
                  value={form.triggerRecoveryFilters}
                  rows={2}
                  onChange={(event) =>
                    updateForm({
                      triggerRecoveryFilters: event.target.value,
                    })
                  }
                  className="max-h-28 rounded-lg border-slate-800 bg-slate-950 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  placeholder="payload.usedPercent<=80"
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Cooldown ms</span>
                <Input
                  type="number"
                  min={1}
                  value={form.triggerCooldownMs}
                  onChange={(event) =>
                    updateForm({ triggerCooldownMs: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="60000"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Repeat ms</span>
                <Input
                  type="number"
                  min={1}
                  value={form.triggerRepeatMs}
                  onChange={(event) =>
                    updateForm({ triggerRepeatMs: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="3600000"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Max Events</span>
                <Input
                  type="number"
                  min={1}
                  value={form.triggerMaxEvents}
                  onChange={(event) =>
                    updateForm({ triggerMaxEvents: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="2"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Window ms</span>
                <Input
                  type="number"
                  min={1}
                  value={form.triggerWindowMs}
                  onChange={(event) =>
                    updateForm({ triggerWindowMs: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="60000"
                />
              </label>
            </div>
          </div>

          {form.targetType === "prompt" ? (
            <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
              <div className="text-xs font-medium text-slate-300">Context</div>
              <Textarea
                value={form.contextPaths}
                rows={2}
                onChange={(event) =>
                  updateForm({ contextPaths: event.target.value })
                }
                className="max-h-28 rounded-lg border-slate-800 bg-slate-950 text-xs text-slate-100 placeholder:text-slate-600"
                placeholder="src/core"
              />
              <Textarea
                value={form.contextPackJson}
                rows={2}
                onChange={(event) =>
                  updateForm({ contextPackJson: event.target.value })
                }
                className="max-h-28 rounded-lg border-slate-800 bg-slate-950 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                placeholder='{"name":"release-check"}'
              />
              <Textarea
                value={form.macros}
                rows={2}
                onChange={(event) => updateForm({ macros: event.target.value })}
                className="max-h-28 rounded-lg border-slate-800 bg-slate-950 text-xs text-slate-100 placeholder:text-slate-600"
                placeholder="/triage --scope backend"
              />
            </div>
          ) : null}

          <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
            <div className="text-xs font-medium text-slate-300">Policies</div>
            <label className="grid gap-1 text-[11px] font-medium text-slate-500">
              <span>Missed Run Policy</span>
              <select
                value={form.missedRunPolicy}
                onChange={(event) =>
                  updateForm({
                    missedRunPolicy: event.target
                      .value as SchedulerMissedRunPolicy,
                  })
                }
                className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
              >
                <option value="enqueue-latest">Enqueue Latest</option>
                <option value="enqueue-all">Enqueue All</option>
                <option value="skip">Skip Missed Runs</option>
              </select>
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Retry Attempts</span>
                <Input
                  type="number"
                  min={1}
                  value={form.retryAttempts}
                  onChange={(event) =>
                    updateForm({ retryAttempts: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="Attempts"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Concurrency Limit</span>
                <Input
                  type="number"
                  min={1}
                  value={form.concurrencyLimit}
                  onChange={(event) =>
                    updateForm({ concurrencyLimit: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="Limit"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Queue Key</span>
                <Input
                  value={form.concurrencyKey}
                  onChange={(event) =>
                    updateForm({ concurrencyKey: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="Shared queue key"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Dedupe Key</span>
                <Input
                  value={form.dedupeKey}
                  onChange={(event) =>
                    updateForm({ dedupeKey: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="Stable job key"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Queue TTL ms</span>
                <Input
                  type="number"
                  min={1}
                  value={form.ttlMs}
                  onChange={(event) =>
                    updateForm({ ttlMs: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="Optional"
                />
              </label>
              <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                <span>Max Duration ms</span>
                <Input
                  type="number"
                  min={1}
                  value={form.maxDurationMs}
                  onChange={(event) =>
                    updateForm({ maxDurationMs: event.target.value })
                  }
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                  placeholder="Optional"
                />
              </label>
            </div>
          </div>

          {form.targetType === "prompt" ? (
            <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
              <div className="text-xs font-medium text-slate-300">Runtime</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Run Mode</span>
                  <select
                    value={form.mode}
                    onChange={(event) =>
                      updateForm({
                        mode: event.target.value as SchedulerFormState["mode"],
                      })
                    }
                    className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                  >
                    <option value="">Default Mode</option>
                    <option value="ask">Ask</option>
                    <option value="machdoch">Machdoch</option>
                  </select>
                </label>
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Provider</span>
                  <select
                    value={form.provider}
                    onChange={(event) => {
                      const provider = event.target
                        .value as SchedulerFormState["provider"];
                      updateForm({
                        provider,
                        reasoning: form.reasoning
                          ? normalizeReasoningModeForProvider(
                              form.reasoning,
                              provider || null,
                              form.model.trim() || null,
                            )
                          : "",
                      });
                    }}
                    className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                  >
                    <option value="">Default Provider</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google</option>
                  </select>
                </label>
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Reasoning</span>
                  <select
                    value={reasoningValue}
                    onChange={(event) =>
                      updateForm({
                        reasoning: event.target
                          .value as SchedulerFormState["reasoning"],
                      })
                    }
                    className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                  >
                    <option value="">Default Reasoning</option>
                    {reasoningOptions.map((reasoning) => (
                      <option key={reasoning} value={reasoning}>
                        {REASONING_LABELS[reasoning]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Model</span>
                  <Input
                    value={form.model}
                    onChange={(event) =>
                      updateForm({
                        model: event.target.value,
                        reasoning: form.reasoning
                          ? normalizeReasoningModeForProvider(
                              form.reasoning,
                              form.provider || null,
                              event.target.value.trim() || null,
                            )
                          : "",
                      })
                    }
                    className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                    placeholder="Workspace default"
                  />
                </label>
              </div>
            </div>
          ) : null}
        </form>
      </SubmitShortcut>
    </aside>
  );
}
