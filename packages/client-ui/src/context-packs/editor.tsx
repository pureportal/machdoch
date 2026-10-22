import {
  cloneElement,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type JSX,
  type ReactElement,
} from "react";
import { Save, RotateCcw } from "lucide-react";
import {
  modelProviderSchema,
  reasoningModeSchema,
  runModeSchema,
  type RuntimeProvider,
  type RunMode,
  type ReasoningMode,
} from "@machdoch/fleet-protocol/runtime-options";
import { contextPackDefinitionSchema } from "@machdoch/fleet-protocol/context-pack-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { ChatSessionContextAttachment } from "../composer/model";
import {
  PROMPT_ENHANCEMENT_LABELS,
  PROMPT_ENHANCEMENT_MODES,
  type PromptEnhancementMode,
} from "../composer/prompt-enhancement-options";
import { getProviderLabel } from "../common/provider-labels";
import type {
  SaveSmartContextPackInput,
  SmartContextPackScope,
  SmartContextPackVariable,
  SmartContextPackSettingOverrides,
} from "./model";
import {
  extractSmartContextPackVariables,
  getContextPackReasoningLabel,
  getContextPackModeLabel,
  getSmartContextPackScopeLabel,
  parseSmartContextPackListInput,
  parseSmartContextPackVariableInput,
} from "./helpers";
import {
  createContextAttachmentsFromPathInput,
  formatAttachmentPathInputValue,
  formatListInputValue,
  formatVariableInputValue,
} from "./editor-content";
import { ContextPackPromptEditor } from "./prompt-editor";
import { ContextWindowPicker } from "../composer/context-window-picker";
import type { ContextWindow } from "@machdoch/fleet-protocol/context-window";

export interface SmartContextPackEditorInitialValue {
  contextWindow?: ContextWindow;
  id?: string;
  temporary?: boolean;
  mode: "create" | "edit";
  name: string;
  scope: SmartContextPackScope;
  instructions: string;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  variables: SmartContextPackVariable[];
  triggerPhrases: string[];
  triggerPathPatterns: string[];
  provider?: RuntimeProvider;
  model?: string;
  runMode?: RunMode;
  reasoning?: ReasoningMode;
  promptEnhancementMode?: PromptEnhancementMode;
  interviewEnabled?: boolean;
  sessionMemoryEnabled?: boolean;
  useWorkspaceMemory?: boolean;
  useGlobalMemory?: boolean;
  uiControlEnabled?: boolean;
}

export interface PackModelOption {
  capabilities?: { contextWindowTokens?: number | null; longContextWindowTokens?: number | null };
  provider: RuntimeProvider;
  id: string;
  label: string;
}

const FIELD_CLASS =
  "h-10 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm text-slate-100 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-500/20";
const TEXT_CLASS =
  "min-h-24 resize-y rounded-lg border-slate-700 bg-slate-950/60 text-sm text-slate-100";
const KEEP_CURRENT = "keep-current";

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}): JSX.Element {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-2 text-xs font-medium text-slate-300">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

const booleanFields = [
  ["interviewEnabled", "Interview"],
  ["sessionMemoryEnabled", "Session memory"],
  ["useWorkspaceMemory", "Workspace memory"],
  ["useGlobalMemory", "Global memory"],
  ["uiControlEnabled", "UI control"],
] as const;

export function SmartContextPackEditorDialog({
  open,
  initialValue,
  workspaceRoot,
  modelOptions = [],
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initialValue: SmartContextPackEditorInitialValue;
  workspaceRoot: string | null;
  modelOptions?: PackModelOption[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: SaveSmartContextPackInput) => void | Promise<void>;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [name, setName] = useState(initialValue.name);
  const [scope, setScope] = useState<SmartContextPackScope>(
    workspaceRoot ? initialValue.scope : "global",
  );
  const [prompt, setPrompt] = useState(initialValue.prompt);
  const [instructions, setInstructions] = useState(initialValue.instructions);
  const [paths, setPaths] = useState(
    formatAttachmentPathInputValue(initialValue.contextAttachments),
  );
  const [variables, setVariables] = useState(
    formatVariableInputValue(initialValue.variables),
  );
  const [phrases, setPhrases] = useState(
    formatListInputValue(initialValue.triggerPhrases),
  );
  const [patterns, setPatterns] = useState(
    formatListInputValue(initialValue.triggerPathPatterns),
  );
  const [settings, setSettings] = useState<SmartContextPackSettingOverrides>({
    temporary: initialValue.temporary === true,
    provider: initialValue.provider,
    model: initialValue.model,
    mode: initialValue.runMode,
    reasoning: initialValue.reasoning,
    contextWindow: initialValue.contextWindow,
    promptEnhancementMode: initialValue.promptEnhancementMode,
    interviewEnabled: initialValue.interviewEnabled,
    sessionMemoryEnabled: initialValue.sessionMemoryEnabled,
    useWorkspaceMemory: initialValue.useWorkspaceMemory,
    useGlobalMemory: initialValue.useGlobalMemory,
    uiControlEnabled: initialValue.uiControlEnabled,
  });
  const [includeModel, setIncludeModel] = useState(
    Boolean(initialValue.provider && initialValue.model),
  );
  const attachments = useMemo(
    () =>
      createContextAttachmentsFromPathInput(
        paths,
        initialValue.contextAttachments,
      ),
    [paths, initialValue.contextAttachments],
  );
  const hasSettings =
    includeModel ||
    Object.entries(settings).some(
      ([key, value]) =>
        !["temporary", "provider", "model"].includes(key) &&
        value !== undefined,
    );
  const hasContent = Boolean(
    prompt.trim() || instructions.trim() || attachments.length || hasSettings,
  );
  const modelMissing = includeModel && !settings.model?.trim();
  const canSave = Boolean(name.trim() && hasContent && !modelMissing);
  const updateSettings = (
    update: Partial<SmartContextPackSettingOverrides>,
  ): void => setSettings((current) => ({ ...current, ...update }));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSave || saving) return;
    const input: SaveSmartContextPackInput = {
      ...settings,
      provider: includeModel ? settings.provider : undefined,
      model: includeModel ? settings.model?.trim() : undefined,
      ...(initialValue.id ? { id: initialValue.id } : {}),
      name: name.trim(),
      scope,
      instructions,
      prompt,
      contextAttachments: attachments,
      variables: [
        ...parseSmartContextPackVariableInput(variables),
        ...extractSmartContextPackVariables(name, instructions, prompt).map(
          (name) => ({ name }),
        ),
      ],
      triggerPhrases: parseSmartContextPackListInput(phrases),
      triggerPathPatterns: parseSmartContextPackListInput(patterns),
    };
    const parsed = contextPackDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      setSaveError(
        parsed.error.issues
          .map((issue) => issue.path.join(".") + ": " + issue.message)
          .join(" "),
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSubmit(parsed.data);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="app-context-pack-dialog grid max-h-[calc(100dvh-32px)] w-[min(1040px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-none"
      >
        <DialogHeader className="border-b border-slate-800 px-6 py-5 text-left">
          <DialogTitle>
            {initialValue.mode === "edit" ? "Edit pack" : "Create pack"}
          </DialogTitle>
        </DialogHeader>
        <SubmitShortcut asChild>
          <form
            onSubmit={(event) => void submit(event)}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
          >
            <div className="grid min-h-0 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="grid content-start gap-5 p-5 sm:p-6">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Field label="Name">
                    <Input
                      autoFocus
                      required
                      maxLength={240}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      className={FIELD_CLASS}
                    />
                  </Field>
                  <fieldset className="grid content-start gap-2">
                    <legend className="mb-2 text-xs font-medium text-slate-300">
                      Scope
                    </legend>
                    <div className="flex rounded-lg border border-slate-700 p-0.5">
                      {(["workspace", "global"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          disabled={option === "workspace" && !workspaceRoot}
                          aria-pressed={scope === option}
                          onClick={() => setScope(option)}
                          className={cn(
                            "h-9 rounded-md px-3 text-xs font-medium disabled:opacity-40",
                            scope === option
                              ? "bg-slate-200 text-slate-950"
                              : "text-slate-400 hover:bg-slate-800",
                          )}
                        >
                          {getSmartContextPackScopeLabel(option)}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>
                <div className="grid gap-2">
                  <span className="text-xs font-medium text-slate-300">
                    Prompt
                  </span>
                  <ContextPackPromptEditor
                    value={prompt}
                    onChange={setPrompt}
                  />
                </div>
                <Field label="Instructions">
                  <Textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    className={TEXT_CLASS}
                  />
                </Field>
                <details className="group rounded-xl border border-slate-800">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-300">
                    Attachments, variables and triggers
                  </summary>
                  <div className="grid gap-4 border-t border-slate-800 p-4">
                    <Field label="Paths">
                      <Textarea
                        value={paths}
                        onChange={(event) => setPaths(event.target.value)}
                        className={TEXT_CLASS}
                        placeholder="One path or URL per line"
                      />
                    </Field>
                    {initialValue.contextAttachments
                      .filter(
                        (attachment) => attachment.source === "media-asset",
                      )
                      .map((attachment) => (
                        <p
                          key={attachment.id}
                          className="truncate text-xs text-slate-400"
                        >
                          {attachment.name}
                        </p>
                      ))}
                    <Field label="Variables">
                      <Textarea
                        value={variables}
                        onChange={(event) => setVariables(event.target.value)}
                        className={TEXT_CLASS}
                        placeholder="name, name=default value"
                      />
                    </Field>
                    <Field label="Trigger phrases">
                      <Input
                        value={phrases}
                        onChange={(event) => setPhrases(event.target.value)}
                        className={FIELD_CLASS}
                        placeholder="Comma-separated phrases"
                      />
                    </Field>
                    <Field label="Path patterns">
                      <Input
                        value={patterns}
                        onChange={(event) => setPatterns(event.target.value)}
                        className={FIELD_CLASS}
                        placeholder="src/**, *.tsx"
                      />
                    </Field>
                  </div>
                </details>
              </div>
              <section className="grid content-start gap-5 border-t border-slate-800 bg-slate-900/35 p-5 sm:p-6 lg:border-t-0 lg:border-l">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">Settings</h3>
                  <button
                    type="button"
                    disabled={!hasSettings}
                    onClick={() => {
                      setIncludeModel(false);
                      setSettings({ temporary: settings.temporary });
                    }}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Clear overrides
                  </button>
                </div>
                <Field label="Apply settings">
                  <select
                    value={settings.temporary ? "temporary" : "persistent"}
                    onChange={(event) =>
                      updateSettings({
                        temporary: event.target.value === "temporary",
                      })
                    }
                    className={FIELD_CLASS}
                  >
                    <option value="persistent">
                      Keep for following prompts
                    </option>
                    <option value="temporary">
                      Temporary (next prompt only)
                    </option>
                  </select>
                </Field>
                {settings.temporary && hasSettings ? (
                  <p className="-mt-3 text-xs leading-5 text-slate-400">
                    Previous settings return after sending. You can reset them
                    before sending.
                  </p>
                ) : null}
                <div className="grid gap-3">
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
                    <input
                      type="checkbox"
                      checked={includeModel}
                      onChange={(event) => {
                        setIncludeModel(event.target.checked);
                        if (!settings.provider)
                          updateSettings({
                            provider: initialValue.provider ?? "openai",
                          });
                      }}
                      className="accent-sky-400"
                    />
                    Override model
                  </label>
                  {includeModel ? (
                    <>
                      <Field label="Provider">
                        <select
                          value={settings.provider ?? "openai"}
                          onChange={(event) =>
                            updateSettings({
                              provider: event.target.value as RuntimeProvider,
                              model: "",
                              contextWindow: undefined,
                            })
                          }
                          className={FIELD_CLASS}
                        >
                          {modelProviderSchema.options.map((provider) => (
                            <option key={provider} value={provider}>
                              {getProviderLabel(provider)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Model">
                        <Input
                          required
                          list="context-pack-models"
                          value={settings.model ?? ""}
                          onChange={(event) =>
                            updateSettings({ model: event.target.value, contextWindow: undefined })
                          }
                          className={FIELD_CLASS}
                          aria-invalid={modelMissing}
                        />
                      </Field>
                      <datalist id="context-pack-models">
                        {modelOptions
                          .filter(
                            (model) => model.provider === settings.provider,
                          )
                          .map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                            </option>
                          ))}
                      </datalist>
                      {modelMissing ? (
                        <p className="text-xs text-amber-200">
                          Choose or enter a model.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Execution mode">
                    <select
                      value={settings.mode ?? KEEP_CURRENT}
                      onChange={(event) =>
                        updateSettings({
                          mode:
                            event.target.value === KEEP_CURRENT
                              ? undefined
                              : (event.target.value as RunMode),
                        })
                      }
                      className={FIELD_CLASS}
                    >
                      <option value={KEEP_CURRENT}>Keep current</option>
                      {runModeSchema.options.map((mode) => (
                        <option key={mode} value={mode}>
                          {getContextPackModeLabel(mode)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Reasoning">
                    <select
                      value={settings.reasoning ?? KEEP_CURRENT}
                      onChange={(event) =>
                        updateSettings({
                          reasoning:
                            event.target.value === KEEP_CURRENT
                              ? undefined
                              : (event.target.value as ReasoningMode),
                        })
                      }
                      className={FIELD_CLASS}
                    >
                      <option value={KEEP_CURRENT}>Keep current</option>
                      {reasoningModeSchema.options.map((reasoning) => (
                        <option key={reasoning} value={reasoning}>
                          {getContextPackReasoningLabel(reasoning)}
                        </option>
                      ))}
                    </select>
                  </Field>
                    <ContextWindowPicker provider={settings.provider} model={settings.model} value={settings.contextWindow} onChange={(contextWindow) => updateSettings({ contextWindow })} capabilities={modelOptions.find((entry) => entry.provider === settings.provider && entry.id === settings.model)?.capabilities} inheritLabel="Keep current" />
                    <Field label="Prompt enhancement">
                    <select
                      value={settings.promptEnhancementMode ?? KEEP_CURRENT}
                      onChange={(event) =>
                        updateSettings({
                          promptEnhancementMode:
                            event.target.value === KEEP_CURRENT
                              ? undefined
                              : (event.target.value as PromptEnhancementMode),
                        })
                      }
                      className={FIELD_CLASS}
                    >
                      <option value={KEEP_CURRENT}>Keep current</option>
                      {PROMPT_ENHANCEMENT_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {PROMPT_ENHANCEMENT_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {booleanFields.map(([key, label]) => (
                    <Field key={key} label={label}>
                      <select
                        value={
                          settings[key] === undefined
                            ? KEEP_CURRENT
                            : settings[key]
                              ? "enabled"
                              : "disabled"
                        }
                        onChange={(event) =>
                          updateSettings({
                            [key]:
                              event.target.value === KEEP_CURRENT
                                ? undefined
                                : event.target.value === "enabled",
                          })
                        }
                        className={FIELD_CLASS}
                      >
                        <option value={KEEP_CURRENT}>Keep current</option>
                        <option value="enabled">Enabled</option>
                        <option value="disabled">Disabled</option>
                      </select>
                    </Field>
                  ))}
                </div>
              </section>
            </div>
            <DialogFooter className="flex-row items-center border-t border-slate-800 px-6 py-4">
              {saveError ? (
                <p role="alert" className="mr-auto text-xs text-red-300">
                  {saveError}
                </p>
              ) : !hasContent ? (
                <p className="mr-auto text-xs text-slate-400">
                  Add a prompt, attachment or setting.
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSave || saving}
                {...SUBMIT_SHORTCUT_ACTION_PROPS}
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save pack"}
              </Button>
            </DialogFooter>
          </form>
        </SubmitShortcut>
      </DialogContent>
    </Dialog>
  );
}
