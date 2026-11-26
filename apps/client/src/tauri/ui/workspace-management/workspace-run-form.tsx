import {
  Braces,
  Copy,
  Layers,
  ListChecks,
  MoreHorizontal,
  Play,
  Plus,
  Server,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import type {
  WorkspaceRunConfiguration,
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
} from "../../../shared/workspace-run.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  addWorkspaceRunConfiguration,
  addWorkspaceRunInput,
  duplicateWorkspaceRunConfiguration,
  removeWorkspaceRunConfiguration,
  setPrimaryWorkspaceRunConfiguration,
  updateWorkspaceRunConfiguration,
  workspaceRunChildCandidates,
  workspaceRunConfigurationIssues,
  type WorkspaceRunNewConfigurationKind,
} from "./workspace-run-editor-model";
import {
  WorkspaceRunCompositeForm,
  WorkspaceRunInputsForm,
} from "./workspace-run-group-forms";
import { WorkspaceRunTaskForm } from "./workspace-run-task-form";

export const WORKSPACE_RUN_INPUTS_SELECTION = "__inputs";

const NEW_CONFIGURATION_OPTIONS: ReadonlyArray<{
  kind: WorkspaceRunNewConfigurationKind;
  label: string;
  icon: LucideIcon;
}> = [
  { kind: "service", label: "Service", icon: Server },
  { kind: "job", label: "Job", icon: Play },
  { kind: "composite", label: "Group", icon: Layers },
];

const configurationIcon = (
  configuration: WorkspaceRunConfiguration,
): LucideIcon =>
  configuration.kind === "composite"
    ? Layers
    : configuration.runType === "job"
      ? Play
      : Server;

const configurationTypeLabel = (
  configuration: WorkspaceRunConfiguration,
): string =>
  configuration.kind === "composite"
    ? "Group"
    : configuration.runType === "job"
      ? "Job"
      : "Service";

export const WorkspaceRunForm = ({
  document,
  selectedId,
  detections,
  disabled,
  onSelect,
  onChange,
}: {
  document: WorkspaceRunConfigurationDocument;
  selectedId: string | null;
  detections: readonly WorkspaceRunDetection[];
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onChange: (document: WorkspaceRunConfigurationDocument) => void;
}): JSX.Element => {
  const issues = workspaceRunConfigurationIssues(document);
  const inputsSelected = selectedId === WORKSPACE_RUN_INPUTS_SELECTION;
  const selected = inputsSelected
    ? null
    : (document.configurations.find(
        (configuration) => configuration.id === selectedId,
      ) ??
      document.configurations[0] ??
      null);
  const selectedIndex = selected
    ? document.configurations.indexOf(selected)
    : -1;
  const selectedIssues = selected
    ? issues.filter((issue) => issue.configurationId === selected.id)
    : [];
  const reviewFields = selected
    ? (detections.find((entry) => entry.configurationId === selected.id)
        ?.uncertainFields ?? [])
    : [];
  const groups = Array.from(
    new Set(
      document.configurations.flatMap((configuration) =>
        configuration.group ? [configuration.group] : [],
      ),
    ),
  ).sort();

  const add = (kind: WorkspaceRunNewConfigurationKind): void => {
    const result = addWorkspaceRunConfiguration(document, kind);
    onChange(result.document);
    onSelect(result.id);
  };
  const replaceSelected = (next: WorkspaceRunConfiguration): void => {
    if (!selected) return;
    onChange(updateWorkspaceRunConfiguration(document, selected.id, next));
    if (next.id !== selected.id) onSelect(next.id);
  };
  const makeDefault = (): void => {
    if (selected)
      onChange(setPrimaryWorkspaceRunConfiguration(document, selected.id));
  };

  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[15rem_minmax(0,1fr)]">
      <nav
        aria-label="Run configurations"
        className="flex min-h-0 flex-col border-b border-slate-800 md:border-r md:border-b-0"
      >
        <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1.5">
          <span className="text-[11px] font-medium text-slate-500">
            Configurations
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Add configuration"
                disabled={disabled}
              >
                <Plus aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              {NEW_CONFIGURATION_OPTIONS.map(({ kind, label, icon: Icon }) => (
                <DropdownMenuItem key={kind} onSelect={() => add(kind)}>
                  <Icon className="size-3.5" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ul className="grid max-h-48 content-start gap-0.5 overflow-y-auto px-2 pb-2 md:max-h-none md:flex-1">
          {document.configurations.map((configuration) => {
            const Icon = configurationIcon(configuration);
            const current = configuration.id === selected?.id;
            const invalid = issues.some(
              (issue) => issue.configurationId === configuration.id,
            );
            return (
              <li key={configuration.id}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => onSelect(configuration.id)}
                  className={cn(
                    "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-slate-300 outline-none transition-colors hover:bg-slate-900 focus-visible:ring-2 focus-visible:ring-sky-500/60",
                    current &&
                      "bg-slate-800/80 text-white hover:bg-slate-800/80",
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-slate-500"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {configuration.name || configuration.id}
                  </span>
                  {configuration.primary ? (
                    <Star
                      aria-label="Default"
                      className="size-3 shrink-0 fill-sky-400 text-sky-400"
                    />
                  ) : null}
                  {invalid ? (
                    <span
                      aria-label="Needs attention"
                      className="size-1.5 shrink-0 rounded-full bg-red-400"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-slate-800 p-2">
          <button
            type="button"
            aria-current={inputsSelected ? "true" : undefined}
            onClick={() => onSelect(WORKSPACE_RUN_INPUTS_SELECTION)}
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-slate-300 outline-none hover:bg-slate-900 focus-visible:ring-2 focus-visible:ring-sky-500/60",
              inputsSelected &&
                "bg-slate-800/80 text-white hover:bg-slate-800/80",
            )}
          >
            <Braces aria-hidden="true" className="size-3.5 text-slate-500" />
            <span className="flex-1">Inputs</span>
            {document.inputs.length > 0 ? (
              <span className="text-xs tabular-nums text-slate-500">
                {document.inputs.length}
              </span>
            ) : null}
          </button>
        </div>
      </nav>

      <div className="min-h-0 min-w-0 overflow-y-auto">
        <div className="grid max-w-4xl gap-5 px-5 py-4">
          {inputsSelected ? (
            <WorkspaceRunInputsForm
              inputs={document.inputs}
              disabled={disabled}
              onAdd={() => onChange(addWorkspaceRunInput(document))}
              onChange={(inputs) => onChange({ ...document, inputs })}
            />
          ) : selected ? (
            <>
              <header className="flex min-w-0 items-center gap-2">
                <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-100">
                  {selected.name || selected.id}
                </h3>
                <span className="shrink-0 text-xs text-slate-500">
                  {configurationTypeLabel(selected)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`More actions for ${selected.name || selected.id}`}
                      disabled={disabled}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuItem
                      onSelect={() => {
                        const result = duplicateWorkspaceRunConfiguration(
                          document,
                          selected.id,
                        );
                        onChange(result.document);
                        onSelect(result.id);
                      }}
                    >
                      <Copy className="size-3.5" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        onChange(
                          removeWorkspaceRunConfiguration(
                            document,
                            selected.id,
                          ),
                        );
                        onSelect(null);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </header>
              {selectedIssues.length > 0 ? (
                <ul className="grid gap-1 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-200">
                  {selectedIssues.map((issue) => (
                    <li key={issue.message}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}
              {reviewFields.length > 0 ? (
                <p className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  Review {reviewFields.join(", ")}
                </p>
              ) : null}
              {selected.kind === "task" ? (
                <WorkspaceRunTaskForm
                  key={selectedIndex}
                  configuration={selected}
                  groups={groups}
                  disabled={disabled}
                  onChange={replaceSelected}
                  onMakeDefault={makeDefault}
                />
              ) : (
                <WorkspaceRunCompositeForm
                  key={selectedIndex}
                  configuration={selected}
                  candidates={workspaceRunChildCandidates(
                    document,
                    selected.id,
                  )}
                  disabled={disabled}
                  onChange={replaceSelected}
                  onMakeDefault={makeDefault}
                />
              )}
            </>
          ) : (
            <EmptyState
              icon={ListChecks}
              title="No run configurations"
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {NEW_CONFIGURATION_OPTIONS.map(
                    ({ kind, label, icon: Icon }) => (
                      <Button
                        key={kind}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => add(kind)}
                      >
                        <Icon aria-hidden="true" />
                        {label}
                      </Button>
                    ),
                  )}
                </div>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
};
