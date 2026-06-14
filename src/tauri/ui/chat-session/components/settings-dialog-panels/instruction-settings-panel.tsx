import {
  FileText,
  Plus,
  RefreshCw,
  Save,
  WandSparkles,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import type {
  DiscoveredInstruction,
  InstructionAudience,
  InstructionMode,
} from "../../../../../core/types.js";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import type {
  InstructionMutationInput,
  WritableInstructionScope,
} from "../../../runtime";
import { cn } from "../../../lib/utils";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsStatus,
} from "./shared";
import type { InstructionSettingsControls } from "./types";

export interface InstructionSettingsPanelProps {
  setup: InstructionSettingsControls;
}

type InstructionEditorMode = "manual" | "ai";
type InstructionAudienceDraft = "default" | InstructionAudience;
type InstructionScopeLabel =
  | WritableInstructionScope
  | "compatibility";

interface InstructionDraft {
  editorMode: InstructionEditorMode;
  name: string;
  path: string;
  scope: WritableInstructionScope;
  activationMode: InstructionMode;
  audience: InstructionAudienceDraft;
  applyTo: string;
  exclude: string;
  keywords: string;
  priority: string;
  prompt: string;
  maxRounds: string;
}

const INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100";
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;
const TEXTAREA_CLASS =
  "min-h-24 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100";

const INSTRUCTION_SCOPE_OPTIONS: ReadonlyArray<{
  value: WritableInstructionScope;
  label: string;
}> = [
  { value: "workspace", label: "Workspace" },
  { value: "user", label: "Global" },
];

const INSTRUCTION_MODE_OPTIONS: ReadonlyArray<{
  value: InstructionMode;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "always", label: "Always" },
  { value: "agent-requested", label: "Agent requested" },
  { value: "manual", label: "Manual" },
  { value: "disabled", label: "Disabled" },
];

const INSTRUCTION_AUDIENCE_OPTIONS: ReadonlyArray<{
  value: InstructionAudienceDraft;
  label: string;
}> = [
  { value: "default", label: "Default" },
  { value: "executor", label: "Executor" },
  { value: "validator", label: "Validator" },
  { value: "generator", label: "Generator" },
  { value: "all", label: "All" },
];

const createEmptyDraft = (
  workspaceAvailable: boolean,
): InstructionDraft => ({
  editorMode: "ai",
  name: "",
  path: "",
  scope: workspaceAvailable ? "workspace" : "user",
  activationMode: "auto",
  audience: "default",
  applyTo: "",
  exclude: "",
  keywords: "",
  priority: "",
  prompt: "",
  maxRounds: "2",
});

const getInstructionScope = (
  instruction: DiscoveredInstruction,
): InstructionScopeLabel => {
  if (instruction.scope === "user") {
    return "user";
  }

  if (instruction.scope === "compatibility") {
    return "compatibility";
  }

  return "workspace";
};

const getInstructionMode = (
  instruction: DiscoveredInstruction,
): InstructionMode => {
  if (instruction.mode) {
    return instruction.mode;
  }

  return instruction.kind === "always-on" ? "always" : "auto";
};

const getApplyToPatterns = (
  instruction: DiscoveredInstruction,
): string[] => {
  if (instruction.applyToPatterns && instruction.applyToPatterns.length > 0) {
    return instruction.applyToPatterns;
  }

  return instruction.applyTo ? [instruction.applyTo] : [];
};

const formatPathDisplay = (path: string): string => {
  const normalizedPath = path.replace(/\\/gu, "/");

  return normalizedPath.length > 92
    ? `...${normalizedPath.slice(-92)}`
    : normalizedPath;
};

const formatStringList = (values: string[] | undefined): string => {
  return values && values.length > 0 ? values.join("\n") : "";
};

const parseStringList = (value: string): string[] | undefined => {
  const entries = value
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? Array.from(new Set(entries)) : undefined;
};

const parseOptionalInteger = (value: string): number | undefined => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return undefined;
  }

  const parsed = Number(normalizedValue);

  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
};

const createMutationInput = (
  draft: InstructionDraft,
): InstructionMutationInput => {
  const input: InstructionMutationInput = {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    scope: draft.scope,
  };
  const priority = parseOptionalInteger(draft.priority);
  const maxRounds = parseOptionalInteger(draft.maxRounds);
  const applyTo = parseStringList(draft.applyTo);
  const exclude = parseStringList(draft.exclude);
  const keywords = parseStringList(draft.keywords);

  if (draft.path.trim()) {
    input.path = draft.path.trim();
  }

  if (draft.activationMode) {
    input.mode = draft.activationMode;
  }

  if (draft.audience !== "default") {
    input.audience = draft.audience;
  }

  if (applyTo) {
    input.applyTo = applyTo;
  }

  if (exclude) {
    input.exclude = exclude;
  }

  if (keywords) {
    input.keywords = keywords;
  }

  if (priority !== undefined) {
    input.priority = priority;
  }

  if (draft.editorMode === "ai" && maxRounds !== undefined) {
    input.maxRounds = maxRounds;
  }

  return input;
};

const sortInstructions = (
  left: DiscoveredInstruction,
  right: DiscoveredInstruction,
): number => {
  const leftScope = getInstructionScope(left);
  const rightScope = getInstructionScope(right);

  if (leftScope !== rightScope) {
    return leftScope.localeCompare(rightScope);
  }

  return left.name.localeCompare(right.name);
};

const scopeLabel = (scope: InstructionScopeLabel): string => {
  if (scope === "user") {
    return "global";
  }

  return scope;
};

export const InstructionSettingsPanel = ({
  setup,
}: InstructionSettingsPanelProps): JSX.Element => {
  const workspaceAvailable = Boolean(setup.workspaceRoot?.trim());
  const [draft, setDraft] = useState<InstructionDraft>(() =>
    createEmptyDraft(workspaceAvailable),
  );
  const sortedInstructions = useMemo(
    () => [...setup.instructions].sort(sortInstructions),
    [setup.instructions],
  );
  const scopeBlocked = draft.scope === "workspace" && !workspaceAvailable;
  const submitDisabled =
    setup.saving ||
    !draft.name.trim() ||
    !draft.prompt.trim() ||
    scopeBlocked;

  useEffect(() => {
    if (!workspaceAvailable && draft.scope === "workspace") {
      setDraft((current) => ({
        ...current,
        scope: "user",
      }));
    }
  }, [draft.scope, workspaceAvailable]);

  const resetDraft = (): void => {
    setDraft(createEmptyDraft(workspaceAvailable));
  };

  const loadInstructionForEditing = (
    instruction: DiscoveredInstruction,
  ): void => {
    const scope = getInstructionScope(instruction);

    if (scope === "compatibility") {
      return;
    }

    setDraft({
      editorMode: "manual",
      name: instruction.name,
      path: instruction.path,
      scope,
      activationMode: getInstructionMode(instruction),
      audience: instruction.audience ?? "default",
      applyTo: formatStringList(getApplyToPatterns(instruction)),
      exclude: formatStringList(instruction.excludePatterns),
      keywords: formatStringList(instruction.keywords),
      priority:
        instruction.priority === undefined ? "" : String(instruction.priority),
      prompt: instruction.body,
      maxRounds: "2",
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (submitDisabled) {
      return;
    }

    const input = createMutationInput(draft);

    if (draft.editorMode === "manual") {
      void setup.onManualSave(input);
      return;
    }

    void setup.onGenerate(input);
  };

  return (
    <div className="grid gap-5">
      <SettingsCard
        title="Instruction files"
        description="Registry includes workspace, global, and compatibility instruction files."
      >
        <div className="grid gap-3 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-400">
              {setup.loading
                ? "Loading instructions..."
                : `${sortedInstructions.length} instruction${
                    sortedInstructions.length === 1 ? "" : "s"
                  }`}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={setup.loading || setup.saving}
              onClick={() => {
                void setup.onRefresh();
              }}
              className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", setup.loading && "animate-spin")} />
              Refresh
            </Button>
          </div>

          {sortedInstructions.length > 0 ? (
            <div className="grid gap-2">
              {sortedInstructions.map((instruction) => {
                const scope = getInstructionScope(instruction);
                const writable = scope !== "compatibility";
                const applyToPatterns = getApplyToPatterns(instruction);

                return (
                  <div
                    key={`${instruction.scope ?? "workspace"}:${instruction.path}`}
                    className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <FileText className="h-4 w-4 text-sky-300" />
                          <p className="break-words text-sm font-medium text-slate-100">
                            {instruction.name}
                          </p>
                        </div>
                        <p className="mt-1 break-all font-mono text-xs leading-5 text-slate-500">
                          {formatPathDisplay(instruction.path)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!writable || setup.saving}
                        onClick={() => loadInstructionForEditing(instruction)}
                        className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                        {scopeLabel(scope)}
                      </Badge>
                      <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                        {getInstructionMode(instruction)}
                      </Badge>
                      {instruction.audience ? (
                        <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                          {instruction.audience}
                        </Badge>
                      ) : null}
                      {instruction.priority !== undefined ? (
                        <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                          priority {instruction.priority}
                        </Badge>
                      ) : null}
                    </div>

                    {applyToPatterns.length > 0 ||
                    instruction.keywords.length > 0 ? (
                      <p className="break-words text-xs leading-5 text-slate-500">
                        {[...applyToPatterns, ...instruction.keywords].join(", ")}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-sm text-slate-400">
              No instruction files found.
            </p>
          )}
        </div>

        {setup.diagnostics.length > 0 ? (
          <div className="grid gap-2 border-t border-slate-800 py-4">
            {setup.diagnostics.map((diagnostic, index) => (
              <p
                key={`${diagnostic.code}:${diagnostic.path ?? index}`}
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs leading-5",
                  diagnostic.level === "error"
                    ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
                    : "border-amber-500/20 bg-amber-500/10 text-amber-200",
                )}
              >
                {diagnostic.code}: {diagnostic.message}
              </p>
            ))}
          </div>
        ) : null}
      </SettingsCard>

      <SettingsCard
        title="Instruction editor"
        description="Manual saves and AI generation share the same metadata."
      >
        <form onSubmit={handleSubmit} className="grid gap-0">
          <SettingPanel label="Action">
            <div className="flex flex-wrap items-center gap-2">
              <ChoiceButtons
                value={draft.editorMode}
                options={[
                  { value: "ai", label: "Generate" },
                  { value: "manual", label: "Manual" },
                ]}
                disabled={setup.saving}
                onChange={(editorMode) => {
                  setDraft((current) => ({
                    ...current,
                    editorMode,
                  }));
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={setup.saving}
                onClick={resetDraft}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </Button>
            </div>
          </SettingPanel>

          <SettingPanel label="Name">
            <Input
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }));
              }}
              className={INPUT_CLASS}
              placeholder="Code review rules"
            />
          </SettingPanel>

          {draft.path.trim() ? (
            <SettingPanel label="Target file">
              <p className="break-all rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-slate-400">
                {formatPathDisplay(draft.path)}
              </p>
            </SettingPanel>
          ) : null}

          <SettingPanel label="Scope">
            <ChoiceButtons
              value={draft.scope}
              options={INSTRUCTION_SCOPE_OPTIONS.map((option) => ({
                ...option,
                disabled: option.value === "workspace" && !workspaceAvailable,
              }))}
              disabled={setup.saving}
              onChange={(scope) => {
                setDraft((current) => ({
                  ...current,
                  scope,
                }));
              }}
            />
          </SettingPanel>

          <SettingPanel label="Activation">
            <ChoiceButtons
              value={draft.activationMode}
              options={INSTRUCTION_MODE_OPTIONS}
              disabled={setup.saving}
              onChange={(activationMode) => {
                setDraft((current) => ({
                  ...current,
                  activationMode,
                }));
              }}
            />
          </SettingPanel>

          <SettingPanel label="Audience">
            <ChoiceButtons
              value={draft.audience}
              options={INSTRUCTION_AUDIENCE_OPTIONS}
              disabled={setup.saving}
              onChange={(audience) => {
                setDraft((current) => ({
                  ...current,
                  audience,
                }));
              }}
            />
          </SettingPanel>

          <SettingPanel
            label="Rules"
            contentClassName="grid gap-3 md:grid-cols-3"
          >
            <label className="grid gap-1 text-xs font-medium text-slate-400">
              <span>Apply to</span>
              <Textarea
                value={draft.applyTo}
                rows={3}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    applyTo: event.target.value,
                  }));
                }}
                className={TEXTAREA_CLASS}
                placeholder="src/**/*.ts"
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-slate-400">
              <span>Exclude</span>
              <Textarea
                value={draft.exclude}
                rows={3}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    exclude: event.target.value,
                  }));
                }}
                className={TEXTAREA_CLASS}
                placeholder="dist/**"
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-slate-400">
              <span>Keywords</span>
              <Textarea
                value={draft.keywords}
                rows={3}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    keywords: event.target.value,
                  }));
                }}
                className={TEXTAREA_CLASS}
                placeholder="review"
              />
            </label>
          </SettingPanel>

          <SettingPanel label="Priority">
            <Input
              type="number"
              value={draft.priority}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  priority: event.target.value,
                }));
              }}
              className={`${MONO_INPUT_CLASS} max-w-32`}
              placeholder="0"
            />
          </SettingPanel>

          {draft.editorMode === "ai" ? (
            <SettingPanel label="Rounds">
              <Input
                type="number"
                min={1}
                max={4}
                value={draft.maxRounds}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    maxRounds: event.target.value,
                  }));
                }}
                className={`${MONO_INPUT_CLASS} max-w-32`}
              />
            </SettingPanel>
          ) : null}

          <SettingPanel
            label={
              draft.editorMode === "manual"
                ? "Instruction body"
                : "Generation request"
            }
            contentClassName="grid gap-3"
          >
            <Textarea
              value={draft.prompt}
              rows={draft.editorMode === "manual" ? 8 : 5}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  prompt: event.target.value,
                }));
              }}
              className="min-h-36 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100"
              placeholder={
                draft.editorMode === "manual"
                  ? "Prefer strict TypeScript and include targeted tests."
                  : "Create instruction rules for React accessibility checks."
              }
            />
          </SettingPanel>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <p className="text-sm leading-6 text-slate-400">
              {scopeBlocked
                ? "Workspace scope needs an active workspace."
                : setup.saving
                  ? "Saving instruction..."
                  : "Instruction changes are ready to save."}
            </p>
            <Button
              type="submit"
              disabled={submitDisabled}
              className="h-9 rounded-lg bg-sky-500 px-4 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50"
            >
              {draft.editorMode === "manual" ? (
                <Save className="h-4 w-4" />
              ) : (
                <WandSparkles className="h-4 w-4" />
              )}
              {draft.editorMode === "manual" ? "Save" : "Generate"}
            </Button>
          </div>

          <SettingsStatus message={setup.message} />
        </form>
      </SettingsCard>
    </div>
  );
};
