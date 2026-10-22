import {
  cloneElement,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type JSX,
  type ReactElement,
} from "react";
import { Save, ChevronRight } from "lucide-react";
import {
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
import type { ChatSessionContextAttachment } from "../composer/model";
import type { PromptEnhancementMode } from "../composer/prompt-enhancement-options";
import type {
  SaveSmartContextPackInput,
  SmartContextPackScope,
  SmartContextPackVariable,
  SmartContextPackSettingOverrides,
} from "./model";
import {
  extractSmartContextPackVariables,
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
import { PackEditorSettings } from "./editor-settings";
import "./editor.css";
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
  capabilities?: {
    contextWindowTokens?: number | null;
    longContextWindowTokens?: number | null;
  };
  provider: RuntimeProvider;
  id: string;
  label: string;
}

const FIELD_CLASS = "app-pack-control";
const TEXT_CLASS = "app-pack-control app-pack-textarea";

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  className?: string;
  children: ReactElement<{ id?: string }>;
}): JSX.Element {
  const id = useId();
  return (
    <div className={`app-pack-field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

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
  const promptId = useId();
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
        className="app-context-pack-dialog"
      >
        <DialogHeader className="app-pack-header">
          <DialogTitle>
            {initialValue.mode === "edit" ? "Edit pack" : "Create pack"}
          </DialogTitle>
        </DialogHeader>
        <SubmitShortcut asChild>
          <form
            onSubmit={(event) => void submit(event)}
            className="app-pack-form"
          >
            <div className="app-pack-body">
              <div className="app-pack-content">
                <div className="app-pack-identity">
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
                  <fieldset className="app-pack-scope">
                    <legend className="app-pack-scope-label">Scope</legend>
                    <div className="app-pack-scope-options">
                      {(["workspace", "global"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          disabled={option === "workspace" && !workspaceRoot}
                          title={
                            option === "workspace" && !workspaceRoot
                              ? "Open a workspace to use this scope"
                              : undefined
                          }
                          aria-pressed={scope === option}
                          onClick={() => setScope(option)}
                          className="app-pack-scope-option"
                        >
                          {getSmartContextPackScopeLabel(option)}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>
                <div className="app-pack-field app-pack-prompt-field">
                  <label htmlFor={promptId}>Prompt</label>
                  <ContextPackPromptEditor
                    id={promptId}
                    value={prompt}
                    onChange={setPrompt}
                  />
                </div>
                <Field label="Instructions" className="app-pack-instructions">
                  <Textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    className={TEXT_CLASS}
                  />
                </Field>
                <details className="app-pack-extras">
                  <summary>
                    <ChevronRight size={16} aria-hidden="true" />
                    Attachments, variables and triggers
                  </summary>
                  <div className="app-pack-extra-fields">
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
                          className="app-pack-attachment-name"
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
              <PackEditorSettings
                settings={settings}
                includeModel={includeModel}
                hasSettings={hasSettings}
                modelOptions={modelOptions}
                onChange={updateSettings}
                onIncludeModelChange={(include) => {
                  setIncludeModel(include);
                  if (!settings.provider)
                    updateSettings({
                      provider: initialValue.provider ?? "openai",
                    });
                }}
                onClear={() => {
                  setIncludeModel(false);
                  setSettings({ temporary: settings.temporary });
                }}
              />
            </div>
            <DialogFooter className="app-pack-footer">
              {saveError ? (
                <p role="alert" className="app-pack-error">
                  {saveError}
                </p>
              ) : !hasContent ? (
                <p className="app-pack-hint">
                  Add a prompt, instructions, attachment or setting.
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="app-pack-cancel"
                disabled={saving}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="app-pack-save"
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
