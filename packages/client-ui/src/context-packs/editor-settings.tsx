import { RotateCcw } from "lucide-react";
import {
  modelProviderSchema,
  reasoningModeSchema,
  runModeSchema,
  type RuntimeProvider,
  type RunMode,
  type ReasoningMode,
} from "@machdoch/fleet-protocol/runtime-options";
import { ContextWindowPicker } from "../composer/context-window-picker";
import {
  PROMPT_ENHANCEMENT_LABELS,
  PROMPT_ENHANCEMENT_MODES,
  type PromptEnhancementMode,
} from "../composer/prompt-enhancement-options";
import { getProviderLabel } from "../common/provider-labels";
import { getContextPackModeLabel } from "./helpers";
import type { SmartContextPackSettingOverrides } from "./model";
import type { PackModelOption } from "./editor";
import { PackSelect } from "./editor-select";
import { PackModelPicker } from "./editor-model-picker";

const KEEP_CURRENT = "keep-current";
const keepCurrent = { value: KEEP_CURRENT, label: "Keep current" };
const reasoningLabels: Record<ReasoningMode, string> = {
  default: "Provider default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
  aeon: "Aeon",
};
const booleanOptions = [
  keepCurrent,
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];
const booleanFields = [
  ["interviewEnabled", "Interview"],
  ["sessionMemoryEnabled", "Session memory"],
  ["useWorkspaceMemory", "Workspace memory"],
  ["useGlobalMemory", "Global memory"],
  ["uiControlEnabled", "UI control"],
] as const;

export function PackEditorSettings({
  settings,
  includeModel,
  hasSettings,
  modelOptions,
  onChange,
  onIncludeModelChange,
  onClear,
}: {
  settings: SmartContextPackSettingOverrides;
  includeModel: boolean;
  hasSettings: boolean;
  modelOptions: PackModelOption[];
  onChange: (update: Partial<SmartContextPackSettingOverrides>) => void;
  onIncludeModelChange: (include: boolean) => void;
  onClear: () => void;
}) {
  return (
    <section className="app-pack-settings" aria-label="Settings">
      <div className="app-pack-settings-heading">
        <h3>Settings</h3>
        <button
          type="button"
          className="app-pack-reset"
          disabled={!hasSettings}
          onClick={onClear}
        >
          <RotateCcw size={14} /> Clear overrides
        </button>
      </div>
      <PackSelect
        label="Apply settings"
        value={settings.temporary ? "temporary" : "persistent"}
        onChange={(value) => onChange({ temporary: value === "temporary" })}
        options={[
          { value: "persistent", label: "This and following prompts" },
          { value: "temporary", label: "Next prompt only" },
        ]}
      />
      <div className="app-pack-model-settings">
        <label className="app-pack-toggle">
          <span>Override model</span>
          <input
            type="checkbox"
            role="switch"
            checked={includeModel}
            onChange={(event) => onIncludeModelChange(event.target.checked)}
          />
        </label>
        {includeModel && (
          <>
            <PackSelect
              label="Provider"
              value={settings.provider ?? "openai"}
              options={modelProviderSchema.options.map((provider) => ({
                value: provider,
                label: getProviderLabel(provider),
              }))}
              onChange={(value) =>
                onChange({
                  provider: value as RuntimeProvider,
                  model: "",
                  contextWindow: undefined,
                })
              }
            />
            <PackModelPicker
              value={settings.model ?? ""}
              options={modelOptions.filter(
                (model) => model.provider === settings.provider,
              )}
              onChange={(model) =>
                onChange({ model, contextWindow: undefined })
              }
            />
          </>
        )}
      </div>
      <div className="app-pack-settings-grid">
        <PackSelect
          label="Execution mode"
          value={settings.mode ?? KEEP_CURRENT}
          options={[
            keepCurrent,
            ...runModeSchema.options.map((mode) => ({
              value: mode,
              label: getContextPackModeLabel(mode),
            })),
          ]}
          onChange={(value) =>
            onChange({
              mode: value === KEEP_CURRENT ? undefined : (value as RunMode),
            })
          }
        />
        <PackSelect
          label="Reasoning"
          value={settings.reasoning ?? KEEP_CURRENT}
          options={[
            keepCurrent,
            ...reasoningModeSchema.options.map((reasoning) => ({
              value: reasoning,
              label: reasoningLabels[reasoning],
            })),
          ]}
          onChange={(value) =>
            onChange({
              reasoning:
                value === KEEP_CURRENT ? undefined : (value as ReasoningMode),
            })
          }
        />
        <div className="app-pack-field">
          <span>Context size</span>
          <ContextWindowPicker
            presentation="field"
            provider={includeModel ? settings.provider : undefined}
            model={includeModel ? settings.model : undefined}
            value={settings.contextWindow}
            onChange={(contextWindow) => onChange({ contextWindow })}
            capabilities={
              modelOptions.find(
                (entry) =>
                  entry.provider === settings.provider &&
                  entry.id === settings.model,
              )?.capabilities
            }
            inheritLabel="Keep current"
          />
        </div>
        <PackSelect
          label="Prompt enhancement"
          value={settings.promptEnhancementMode ?? KEEP_CURRENT}
          options={[
            keepCurrent,
            ...PROMPT_ENHANCEMENT_MODES.map((mode) => ({
              value: mode,
              label: PROMPT_ENHANCEMENT_LABELS[mode],
            })),
          ]}
          onChange={(value) =>
            onChange({
              promptEnhancementMode:
                value === KEEP_CURRENT
                  ? undefined
                  : (value as PromptEnhancementMode),
            })
          }
        />
      </div>
      <div className="app-pack-settings-grid app-pack-preferences">
        {booleanFields.map(([key, label]) => (
          <PackSelect
            key={key}
            label={label}
            value={
              settings[key] === undefined
                ? KEEP_CURRENT
                : settings[key]
                  ? "enabled"
                  : "disabled"
            }
            options={booleanOptions}
            onChange={(value) =>
              onChange({
                [key]: value === KEEP_CURRENT ? undefined : value === "enabled",
              })
            }
          />
        ))}
      </div>
    </section>
  );
}
