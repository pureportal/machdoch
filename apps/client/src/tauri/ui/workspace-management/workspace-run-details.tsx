import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import {
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Play,
  RotateCw,
  Square,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunInput,
  WorkspaceRunInputValues,
} from "../../../shared/workspace-run.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { WorkspaceRunArguments } from "./workspace-run-arguments";
import {
  formatWorkspaceRunDuration,
  workspaceRunCanRestart,
  workspaceRunCommandPreview,
  workspaceRunConfigurationLabel,
  workspaceRunCurrentFailure,
  workspaceRunDirectAction,
  workspaceRunElapsed,
  workspaceRunInputValueLabel,
  workspaceRunIsActive,
  workspaceRunStatusPorts,
  workspaceRunStatusPresentation,
  workspaceRunStatusUrls,
  workspaceRunType,
} from "./workspace-run-model";
import { WorkspaceRunOutput } from "./workspace-run-output";
import { WorkspaceRunStatusDot } from "./workspace-run-status-dot";

export type WorkspaceRunAction = "start" | "stop" | "restart";

const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [ticking]);
  return now;
};

const StatusLine = ({
  status,
}: {
  status: WorkspaceRunConfigurationStatus;
}): JSX.Element => {
  const active = workspaceRunIsActive(status);
  const presentation = workspaceRunStatusPresentation(status);
  const now = useNow(active);
  const elapsed = workspaceRunElapsed(status, now);
  const failedExitCode =
    status.state === "crashed" && status.exitCode !== null
      ? status.exitCode
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400"
    >
      <WorkspaceRunStatusDot presentation={presentation} active={active} />
      <span className="text-slate-300">{presentation.label}</span>
      {elapsed !== null ? (
        <span>
          {active
            ? formatWorkspaceRunDuration(elapsed)
            : `in ${formatWorkspaceRunDuration(elapsed)}`}
        </span>
      ) : null}
      {failedExitCode !== null ? <span>Exit code {failedExitCode}</span> : null}
      {status.restartCount > 0 ? (
        <span>
          {status.restartCount} restart{status.restartCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
};

const LastRunArguments = ({
  status,
  inputs,
}: {
  status: WorkspaceRunConfigurationStatus;
  inputs: readonly WorkspaceRunInput[];
}): JSX.Element | null => {
  const entries = inputs.flatMap((input) => {
    const value = status.inputValues[input.id];
    return value === undefined
      ? []
      : [[input.label, workspaceRunInputValueLabel(input, value)] as const];
  });
  if (status.startedAt === null || entries.length === 0) return null;

  return (
    <dl className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
      {entries.map(([label, value]) => (
        <div
          key={label}
          className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5"
        >
          <dt className="text-slate-500">{label}</dt>
          <dd className="text-slate-300">{value}</dd>
        </div>
      ))}
    </dl>
  );
};

const CommandPreview = ({
  workingDirectory,
  command,
}: {
  workingDirectory: string;
  command: string;
}): JSX.Element => (
  <CopyContextMenu values={[{ label: "Copy command", value: command }]}>
    <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-5 text-slate-300">
      {workingDirectory !== "." ? (
        <span className="mr-1.5 text-slate-500">{workingDirectory}</span>
      ) : null}
      <span className="mr-1.5 text-sky-300/80 select-none">$</span>
      <span className="[overflow-wrap:anywhere] break-words">{command}</span>
    </div>
  </CopyContextMenu>
);

const CompositeSteps = ({
  status,
  onSelectConfiguration,
}: {
  status: WorkspaceRunConfigurationStatus;
  onSelectConfiguration: (configurationId: string) => void;
}): JSX.Element | null => {
  if (status.configuration.kind !== "composite") return null;
  const sequential = status.configuration.startOrder === "sequence";

  return (
    <ol className="grid gap-1.5 sm:grid-cols-2">
      {status.children.map((child, index) => {
        const presentation = workspaceRunStatusPresentation(child);
        return (
          <li key={child.configuration.id}>
            <button
              type="button"
              onClick={() => onSelectConfiguration(child.configuration.id)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md border border-slate-800/80 px-2.5 py-2 text-left text-xs outline-none hover:border-slate-700 hover:bg-slate-900/60 focus-visible:ring-2 focus-visible:ring-sky-500/70"
            >
              {sequential ? (
                <span className="w-3 shrink-0 text-slate-500 tabular-nums">
                  {index + 1}
                </span>
              ) : null}
              <WorkspaceRunStatusDot
                presentation={presentation}
                active={workspaceRunIsActive(child)}
              />
              <span className="min-w-0 flex-1 truncate text-slate-300">
                {workspaceRunConfigurationLabel(child, status.children)}
              </span>
              <span className="shrink-0 text-slate-500">
                {presentation.label}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
};

const RunLinks = ({
  status,
  onOpenUrl,
}: {
  status: WorkspaceRunConfigurationStatus;
  onOpenUrl: (url: string) => void;
}): JSX.Element | null => {
  const ports = workspaceRunStatusPorts(status);
  const urls = workspaceRunStatusUrls(status);
  if (ports.length === 0 && urls.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      {urls.map((url) => (
        <CopyContextMenu
          key={url}
          selectable={false}
          values={[{ label: "Copy URL", value: url }]}
        >
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1 text-sky-300 outline-none hover:text-sky-200 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-sky-500"
            onClick={() => onOpenUrl(url)}
          >
            <span className="truncate">{url}</span>
            <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
          </button>
        </CopyContextMenu>
      ))}
      {ports.length > 0 ? (
        <span>
          Port{ports.length === 1 ? "" : "s"} {ports.join(", ")}
        </span>
      ) : null}
    </div>
  );
};

const RunDiagnostic = ({
  status,
}: {
  status: WorkspaceRunConfigurationStatus;
}): JSX.Element | null => {
  const failure = workspaceRunCurrentFailure(status);
  const failedHealth = [status, ...status.children]
    .filter((candidate) => candidate.health?.state === "failed")
    .sort(
      (left, right) =>
        (right.health?.checkedAt ?? 0) - (left.health?.checkedAt ?? 0),
    )[0]?.health;
  const diagnostic = failure?.message ?? failedHealth?.message;
  if (!diagnostic) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-red-900/60 bg-red-950/25 px-2.5 py-2 text-xs text-red-200"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{diagnostic}</span>
    </div>
  );
};

export const WorkspaceRunDetails = ({
  status,
  inputs,
  values,
  errors,
  busyAction,
  onValuesChange,
  onAction,
  onSelectConfiguration,
  onOpenUrl,
}: {
  status: WorkspaceRunConfigurationStatus;
  inputs: readonly WorkspaceRunInput[];
  values: WorkspaceRunInputValues;
  errors: Record<string, string>;
  busyAction: WorkspaceRunAction | null;
  onValuesChange: (values: WorkspaceRunInputValues) => void;
  onAction: (action: WorkspaceRunAction) => void;
  onSelectConfiguration: (configurationId: string) => void;
  onOpenUrl: (url: string) => void;
}): JSX.Element => {
  const { configuration } = status;
  const active = workspaceRunIsActive(status);
  const directAction = workspaceRunDirectAction(status);
  const invalid = Object.keys(errors).length > 0;
  const preview = workspaceRunCommandPreview(status, inputs, values);
  const job = workspaceRunType(status) === "job";

  return (
    <SubmitShortcut asChild>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-start gap-3 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-100">
              {configuration.name}
            </h2>
            <StatusLine status={status} />
            <LastRunArguments status={status} inputs={inputs} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {workspaceRunCanRestart(status) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || invalid}
                onClick={() => onAction("restart")}
              >
                {busyAction === "restart" ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <RotateCw aria-hidden="true" />
                )}
                Restart
              </Button>
            ) : null}
            {directAction === "stop" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Stop ${configuration.name}`}
                disabled={busyAction !== null}
                onClick={() => onAction("stop")}
              >
                {busyAction === "stop" ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <Square
                    aria-hidden="true"
                    className="size-3.5 fill-current"
                  />
                )}
                Stop
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                aria-label={`Run ${configuration.name}`}
                disabled={
                  busyAction !== null || invalid || directAction === "none"
                }
                onClick={() => onAction("start")}
                className="min-w-20"
                {...SUBMIT_SHORTCUT_ACTION_PROPS}
              >
                {busyAction === "start" || directAction === "none" ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <Play aria-hidden="true" />
                )}
                {job && status.startedAt !== null && !active
                  ? "Run again"
                  : "Run"}
              </Button>
            )}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid max-h-[55%] shrink-0 gap-4 overflow-y-auto border-b border-slate-800 px-5 py-4 empty:hidden">
            {inputs.length > 0 ? (
              <WorkspaceRunArguments
                inputs={inputs}
                values={values}
                errors={errors}
                disabled={busyAction !== null}
                onChange={onValuesChange}
              />
            ) : null}
            {preview !== null && configuration.kind === "task" ? (
              <CommandPreview
                workingDirectory={configuration.workingDirectory}
                command={preview}
              />
            ) : null}
            {configuration.kind === "composite" ? (
              <CompositeSteps
                status={status}
                onSelectConfiguration={onSelectConfiguration}
              />
            ) : null}
            {workspaceRunStatusPorts(status).length > 0 ||
            workspaceRunStatusUrls(status).length > 0 ? (
              <RunLinks status={status} onOpenUrl={onOpenUrl} />
            ) : null}
            {workspaceRunCurrentFailure(status) ||
            [status, ...status.children].some(
              (candidate) => candidate.health?.state === "failed",
            ) ? (
              <RunDiagnostic status={status} />
            ) : null}
          </div>
          <WorkspaceRunOutput status={status} className="flex-1" />
        </div>
      </div>
    </SubmitShortcut>
  );
};
