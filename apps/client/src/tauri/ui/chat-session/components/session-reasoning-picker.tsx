import { Check } from "lucide-react";
import { ReasoningIcons, type ComposerIconProps } from "@machdoch/product-ui";
import { useCallback, useMemo, useState, type JSX } from "react";
import type { ReasoningMode } from "../../runtime";
import { isReasoningMode } from "../../../../core/runtime-contract.generated.js";
import { getDiscoveredDefaultReasoningMode } from "../../../../core/model-capabilities.js";
import { getDefaultCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-defaults.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import type {
  CommandDefinition,
  CommandPage,
  CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { RuntimeProvider } from "../../model-catalog";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
} from "../../reasoning-options";
import { WorkspaceDefaultIndicator } from "./workspace-default-indicator";

const REASONING_META: Record<
  ReasoningMode,
  {
    label: string;
    description: string;
    icon: (props: ComposerIconProps) => JSX.Element;
  }
> = {
  default: {
    label: "Provider default",
    description:
      "Use the provider or selected model's default reasoning effort.",
    icon: ReasoningIcons.default,
  },
  none: {
    label: "None",
    description:
      "Use the lowest available reasoning setting for latency-sensitive work.",
    icon: ReasoningIcons.none,
  },
  minimal: {
    label: "Minimal",
    description:
      "Prefer minimal internal thinking where the provider supports it.",
    icon: ReasoningIcons.minimal,
  },
  low: {
    label: "Low",
    description: "Favor speed and lower token use for simple tasks.",
    icon: ReasoningIcons.low,
  },
  medium: {
    label: "Medium",
    description: "Balance quality, cost, and latency for everyday agent work.",
    icon: ReasoningIcons.medium,
  },
  high: {
    label: "High",
    description:
      "Spend more effort on planning, coding, and multi-step reasoning.",
    icon: ReasoningIcons.high,
  },
  xhigh: {
    label: "XHigh",
    description: "Use extended effort for long-horizon or complex agent tasks.",
    icon: ReasoningIcons.xhigh,
  },
  max: {
    label: "Max",
    description:
      "Use the highest mapped effort where the provider supports it.",
    icon: ReasoningIcons.max,
  },
  ultra: {
    label: "Ultra",
    description: "Use maximum reasoning effort.",
    icon: ReasoningIcons.ultra,
  },
  aeon: {
    label: "Aeon",
    description: "Keep working until stopped.",
    icon: ReasoningIcons.aeon,
  },
};

export interface SessionReasoningPickerProps {
  provider: RuntimeProvider;
  model: string;
  activeReasoning: ReasoningMode;
  defaultReasoning: ReasoningMode;
  isUsingWorkspaceDefaultReasoning: boolean;
  onSessionReasoningSelection: (reasoning: ReasoningMode | null) => void;
}

export const SessionReasoningPicker = ({
  provider,
  model,
  activeReasoning,
  defaultReasoning,
  isUsingWorkspaceDefaultReasoning,
  onSessionReasoningSelection,
}: SessionReasoningPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const reasoningModes = useMemo(
    () => getReasoningModesForProvider(provider, model),
    [model, provider],
  );
  const displayActiveReasoning = normalizeReasoningModeForProvider(
    activeReasoning,
    provider,
    model,
  );
  const displayDefaultReasoning = normalizeReasoningModeForProvider(
    defaultReasoning,
    provider,
    model,
  );
  const modelDefaultReasoning = getDiscoveredDefaultReasoningMode(
    provider,
    model,
  );
  const resultingReasoning =
    modelDefaultReasoning &&
    isReasoningMode(modelDefaultReasoning) &&
    modelDefaultReasoning !== "default"
      ? normalizeReasoningModeForProvider(
          modelDefaultReasoning,
          provider,
          model,
        )
      : null;
  const displayResultingReasoning = (
    reasoning: ReasoningMode,
  ): ReasoningMode =>
    reasoning === "default" ? (resultingReasoning ?? reasoning) : reasoning;
  const activeMeta =
    REASONING_META[displayResultingReasoning(displayActiveReasoning)];
  const defaultMeta =
    REASONING_META[displayResultingReasoning(displayDefaultReasoning)];
  const ActiveReasoningIcon = activeMeta.icon;
  const WorkspaceDefaultReasoningIcon = defaultMeta.icon;
  const selectReasoning = useCallback(
    (reasoning: ReasoningMode | null): void => {
      onSessionReasoningSelection(reasoning);
      setOpen(false);
    },
    [onSessionReasoningSelection],
  );
  const sessionReasoningOptions = useMemo(
    () => reasoningModes.filter((reasoning) => reasoning !== "default"),
    [reasoningModes],
  );
  const reasoningCommandPage = useMemo<CommandPage>(() => {
    const options: CommandPageItem[] = [
      {
        id: "workspace-default",
        title: `Workspace default (${defaultMeta.label})`,
        current: isUsingWorkspaceDefaultReasoning,
        numericKey: "1",
        execute: () => selectReasoning(null),
      },
      ...sessionReasoningOptions.map(
        (reasoning, index): CommandPageItem => ({
          id: reasoning,
          title: REASONING_META[reasoning].label,
          current:
            !isUsingWorkspaceDefaultReasoning &&
            displayActiveReasoning === reasoning,
          numericKey: String(index + 2) as CommandPageItem["numericKey"],
          execute: () => selectReasoning(reasoning),
        }),
      ),
    ];
    return {
      id: "chat-session-reasoning",
      title: "Reasoning mode",
      searchPlaceholder: "Choose reasoning mode",
      numericSelection: true,
      groups: [{ id: "reasoning", items: options }],
    };
  }, [
    defaultMeta.label,
    displayActiveReasoning,
    isUsingWorkspaceDefaultReasoning,
    selectReasoning,
    sessionReasoningOptions,
  ]);
  const reasoningCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "chat.session.reasoning.select",
        title: "Choose reasoning mode",
        group: "Chat",
        keywords: ["thinking", "effort"],
        scope: { kind: "view", ownerId: "chat" },
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("chat.session.reasoning.select"),
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        children: () => reasoningCommandPage,
      },
    ],
    [reasoningCommandPage],
  );
  useOptionalRegisterCommands(reasoningCommands);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ControlTooltip
        content={`Reasoning mode: ${activeMeta.label}${
          isUsingWorkspaceDefaultReasoning ? " (workspace default)" : ""
        }`}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={`Reasoning mode: ${activeMeta.label}${isUsingWorkspaceDefaultReasoning ? " (workspace default)" : ""}`}
            data-reasoning-mode={displayResultingReasoning(
              displayActiveReasoning,
            )}
            data-reasoning-source={
              isUsingWorkspaceDefaultReasoning ? "workspace" : "session"
            }
            data-active={
              displayResultingReasoning(displayActiveReasoning) !== "none" &&
              displayResultingReasoning(displayActiveReasoning) !== "default"
            }
            className="app-reasoning-picker-button app-composer-toolbar-control relative h-8 w-8 rounded-full border p-0 shadow-none"
          >
            <ActiveReasoningIcon className="h-3.5 w-3.5" />
            {isUsingWorkspaceDefaultReasoning ? (
              <WorkspaceDefaultIndicator />
            ) : null}
          </Button>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent
        align="start"
        className="w-96 rounded-3xl border-slate-800 bg-slate-950/95 p-5 shadow-2xl backdrop-blur-xl"
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
              Reasoning mode
            </p>
            <p className="text-sm leading-6 text-slate-400">
              Set a session-specific reasoning effort for providers that expose
              reasoning controls.
            </p>
          </div>

          <button
            type="button"
            aria-label="Use workspace default reasoning"
            onClick={() => selectReasoning(null)}
            className={cn(
              "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
              isUsingWorkspaceDefaultReasoning
                ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-sky-200">
              <WorkspaceDefaultReasoningIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">
                  Workspace default
                </p>
                {isUsingWorkspaceDefaultReasoning ? (
                  <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-200">
                    Current
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                {`Currently ${defaultMeta.label}.`}
              </p>
            </div>
          </button>

          <div className="grid gap-2">
            {sessionReasoningOptions.map((reasoning) => {
              const meta = REASONING_META[reasoning];
              const ReasoningIcon = meta.icon;
              const isSelected =
                displayActiveReasoning === reasoning &&
                !isUsingWorkspaceDefaultReasoning;

              return (
                <button
                  key={reasoning}
                  type="button"
                  aria-label={`Choose ${meta.label} reasoning`}
                  onClick={() => selectReasoning(reasoning)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
                    isSelected
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950",
                      isSelected ? "text-sky-200" : "text-slate-300",
                    )}
                  >
                    <ReasoningIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-100">
                        {meta.label}
                      </p>
                      {isSelected ? (
                        <Badge className="border-slate-700 bg-slate-950 text-slate-200">
                          <Check className="mr-1 h-3 w-3" />
                          Current
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      {meta.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
