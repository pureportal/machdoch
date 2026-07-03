import {
  Check,
  CircleDashed,
  Search,
  Sparkles,
} from "lucide-react";
import type { JSX } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import {
  PROMPT_ENHANCEMENT_LABELS,
  type PromptEnhancementMode,
} from "../_helpers/prompt-enhancement";

export interface SessionPromptEnhancementPickerProps {
  mode: PromptEnhancementMode;
  webSearchAvailable: boolean;
  webSearchUnavailableReason: string;
  onModeChange: (mode: PromptEnhancementMode) => void;
}

const PROMPT_ENHANCEMENT_OPTIONS: ReadonlyArray<{
  mode: PromptEnhancementMode;
  description: string;
  icon: typeof Sparkles;
}> = [
  {
    mode: "off",
    description: "Send the request exactly as written.",
    icon: CircleDashed,
  },
  {
    mode: "simple",
    description: "Rewrite the request for clarity before the task starts.",
    icon: Sparkles,
  },
  {
    mode: "web-search",
    description:
      "Research current external context before rewriting when it matters.",
    icon: Search,
  },
];

export const SessionPromptEnhancementPicker = ({
  mode,
  webSearchAvailable,
  webSearchUnavailableReason,
  onModeChange,
}: SessionPromptEnhancementPickerProps): JSX.Element => {
  const activeLabel = PROMPT_ENHANCEMENT_LABELS[mode];
  const active = mode !== "off";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`Prompt enhancement: ${activeLabel}`}
          className={cn(
            "h-8 w-8 rounded-full border border-slate-800 bg-slate-950/70 p-0 text-slate-300 shadow-none hover:border-fuchsia-500/30 hover:bg-slate-900 hover:text-fuchsia-100",
            active && "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-100",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 rounded-3xl border-slate-800 bg-slate-950/95 p-5 shadow-2xl backdrop-blur-xl"
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
              Prompt enhancement
            </p>
            <p className="text-sm leading-6 text-slate-400">
              Preprocess the composer request before the normal task or
              interview flow receives it.
            </p>
          </div>

          <div className="grid gap-2">
            {PROMPT_ENHANCEMENT_OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = mode === option.mode;
              const disabled =
                option.mode === "web-search" && !webSearchAvailable;

              return (
                <button
                  key={option.mode}
                  type="button"
                  aria-label={`Choose ${PROMPT_ENHANCEMENT_LABELS[option.mode]}`}
                  disabled={disabled}
                  onClick={() => onModeChange(option.mode)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
                    selected
                      ? "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                    disabled &&
                      "cursor-not-allowed border-dashed border-slate-800 bg-slate-950/40 text-slate-600 hover:border-slate-800 hover:bg-slate-950/40 hover:text-slate-600",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950",
                      selected ? "text-fuchsia-200" : "text-slate-300",
                      disabled && "text-slate-600",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-100">
                        {PROMPT_ENHANCEMENT_LABELS[option.mode]}
                      </p>
                      {selected ? (
                        <Badge className="border-slate-700 bg-slate-950 text-slate-200">
                          <Check className="mr-1 h-3 w-3" />
                          Current
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      {disabled ? webSearchUnavailableReason : option.description}
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
