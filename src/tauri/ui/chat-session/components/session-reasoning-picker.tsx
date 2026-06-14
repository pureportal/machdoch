import { Brain, Check, CircleDashed } from "lucide-react";
import type { JSX } from "react";
import type { ReasoningMode } from "../../../runtime";
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
  { label: string; description: string }
> = {
  default: {
    label: "Provider default",
    description: "Use the provider or selected model's default reasoning effort.",
  },
  none: {
    label: "None",
    description: "Use the lowest available reasoning setting for latency-sensitive work.",
  },
  minimal: {
    label: "Minimal",
    description: "Prefer minimal internal thinking where the provider supports it.",
  },
  low: {
    label: "Low",
    description: "Favor speed and lower token use for simple tasks.",
  },
  medium: {
    label: "Medium",
    description: "Balance quality, cost, and latency for everyday agent work.",
  },
  high: {
    label: "High",
    description: "Spend more effort on planning, coding, and multi-step reasoning.",
  },
  xhigh: {
    label: "XHigh",
    description: "Use extended effort for long-horizon or complex agent tasks.",
  },
  max: {
    label: "Max",
    description: "Use the highest mapped effort where the provider supports it.",
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
          className={cn(
            "h-8 w-8 rounded-full border border-slate-800 bg-slate-950/70 p-0 text-slate-300 shadow-none hover:border-cyan-500/30 hover:bg-slate-900 hover:text-cyan-100",
            !isUsingWorkspaceDefaultReasoning &&
              "border-cyan-500/30 bg-cyan-500/10 text-cyan-100",
          )}
        >
          <Brain className="h-3.5 w-3.5" />
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
                ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-100"
                : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-slate-300">
              <CircleDashed className="h-4 w-4" />
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
                {`Currently ${REASONING_META[displayDefaultReasoning].label}. Use workspace config, profile, or environment default.`}
              </p>
            </div>
          </button>

          <div className="grid gap-2">
            {sessionReasoningOptions.map((reasoning) => {
              const meta = REASONING_META[reasoning];
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
                      ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-cyan-200">
                    <Brain className="h-4 w-4" />
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
