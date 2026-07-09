import {
  Check,
  ChevronsUp,
  CircleDashed,
  CircleOff,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
  Sparkles,
  Tally5,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import type { ReasoningMode } from "../../runtime";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import type { RuntimeProvider } from "../../model-catalog";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
} from "../../reasoning-options";

const REASONING_META: Record<
  ReasoningMode,
  {
    label: string;
    description: string;
    icon: LucideIcon;
    triggerClassName: string;
    selectedClassName: string;
    iconClassName: string;
  }
> = {
  default: {
    label: "Provider default",
    description: "Use the provider or selected model's default reasoning effort.",
    icon: CircleDashed,
    triggerClassName:
      "border-slate-800 bg-slate-950/70 text-slate-300 hover:border-cyan-500/30 hover:bg-slate-900 hover:text-cyan-100",
    selectedClassName: "border-cyan-500/30 bg-cyan-500/10 text-cyan-100",
    iconClassName: "text-slate-300",
  },
  none: {
    label: "None",
    description: "Use the lowest available reasoning setting for latency-sensitive work.",
    icon: CircleOff,
    triggerClassName:
      "border-slate-700 bg-slate-900/80 text-slate-200 hover:border-slate-600 hover:bg-slate-900 hover:text-slate-100",
    selectedClassName: "border-slate-600 bg-slate-800/80 text-slate-100",
    iconClassName: "text-slate-300",
  },
  minimal: {
    label: "Minimal",
    description: "Prefer minimal internal thinking where the provider supports it.",
    icon: SignalZero,
    triggerClassName:
      "border-teal-500/25 bg-teal-500/10 text-teal-100 hover:border-teal-400/40 hover:bg-teal-500/15 hover:text-white",
    selectedClassName: "border-teal-500/30 bg-teal-500/10 text-teal-100",
    iconClassName: "text-teal-200",
  },
  low: {
    label: "Low",
    description: "Favor speed and lower token use for simple tasks.",
    icon: SignalLow,
    triggerClassName:
      "border-cyan-500/25 bg-cyan-500/10 text-cyan-100 hover:border-cyan-400/40 hover:bg-cyan-500/15 hover:text-white",
    selectedClassName: "border-cyan-500/30 bg-cyan-500/10 text-cyan-100",
    iconClassName: "text-cyan-200",
  },
  medium: {
    label: "Medium",
    description: "Balance quality, cost, and latency for everyday agent work.",
    icon: SignalMedium,
    triggerClassName:
      "border-sky-500/25 bg-sky-500/10 text-sky-100 hover:border-sky-400/40 hover:bg-sky-500/15 hover:text-white",
    selectedClassName: "border-sky-500/30 bg-sky-500/10 text-sky-100",
    iconClassName: "text-sky-200",
  },
  high: {
    label: "High",
    description: "Spend more effort on planning, coding, and multi-step reasoning.",
    icon: SignalHigh,
    triggerClassName:
      "border-amber-500/30 bg-amber-500/10 text-amber-100 hover:border-amber-400/40 hover:bg-amber-500/15 hover:text-white",
    selectedClassName: "border-amber-500/30 bg-amber-500/10 text-amber-100",
    iconClassName: "text-amber-200",
  },
  xhigh: {
    label: "XHigh",
    description: "Use extended effort for long-horizon or complex agent tasks.",
    icon: ChevronsUp,
    triggerClassName:
      "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-100 hover:border-fuchsia-400/40 hover:bg-fuchsia-500/15 hover:text-white",
    selectedClassName: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-100",
    iconClassName: "text-fuchsia-200",
  },
  max: {
    label: "Max",
    description: "Use the highest mapped effort where the provider supports it.",
    icon: Tally5,
    triggerClassName:
      "border-rose-500/30 bg-rose-500/10 text-rose-100 hover:border-rose-400/40 hover:bg-rose-500/15 hover:text-white",
    selectedClassName: "border-rose-500/30 bg-rose-500/10 text-rose-100",
    iconClassName: "text-rose-200",
  },
  ultra: {
    label: "Ultra",
    description:
      "Use maximum GPT-5.6 reasoning with proactive parallel subagents.",
    icon: Sparkles,
    triggerClassName:
      "border-violet-400/35 bg-violet-400/10 text-violet-100 hover:border-violet-300/50 hover:bg-violet-400/15 hover:text-white",
    selectedClassName:
      "border-violet-400/35 bg-violet-400/10 text-violet-100",
    iconClassName: "text-violet-200",
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
  const reasoningModes = getReasoningModesForProvider(provider, model);
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
  const activeMeta = REASONING_META[displayActiveReasoning];
  const defaultMeta = REASONING_META[displayDefaultReasoning];
  const ActiveReasoningIcon = activeMeta.icon;
  const WorkspaceDefaultReasoningIcon = defaultMeta.icon;
  const sessionReasoningOptions = reasoningModes.filter(
    (reasoning) => reasoning !== "default",
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`Reasoning mode: ${activeMeta.label}`}
          title={`Reasoning mode: ${activeMeta.label}${
            isUsingWorkspaceDefaultReasoning ? " (workspace default)" : ""
          }`}
          data-reasoning-mode={displayActiveReasoning}
          data-reasoning-source={
            isUsingWorkspaceDefaultReasoning ? "workspace" : "session"
          }
          className={cn(
            "app-reasoning-picker-button h-8 w-8 rounded-full border p-0 shadow-none",
            activeMeta.triggerClassName,
          )}
        >
          <ActiveReasoningIcon className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
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
            onClick={() => onSessionReasoningSelection(null)}
            className={cn(
              "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
              isUsingWorkspaceDefaultReasoning
                ? defaultMeta.selectedClassName
                : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
            )}
          >
            <div
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950",
                defaultMeta.iconClassName,
              )}
            >
              <WorkspaceDefaultReasoningIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">
                  Workspace default
                </p>
                {isUsingWorkspaceDefaultReasoning ? (
                  <Badge className="border-cyan-500/20 bg-cyan-500/10 text-cyan-200">
                    Current
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                {`Currently ${REASONING_META[displayDefaultReasoning].label}. Use workspace config or environment default.`}
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
                  onClick={() => onSessionReasoningSelection(reasoning)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
                    isSelected
                      ? meta.selectedClassName
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950",
                      meta.iconClassName,
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
