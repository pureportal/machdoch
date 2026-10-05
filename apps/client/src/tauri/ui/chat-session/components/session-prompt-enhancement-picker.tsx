import { Check } from "lucide-react";
import {
  OffIcon,
  SearchIcon,
  PromptEnhancementIcon,
  type ComposerIconProps,
} from "@machdoch/product-ui";
import { useMemo, type JSX } from "react";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import type {
  CommandDefinition,
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
  icon: (props: ComposerIconProps) => JSX.Element;
}> = [
  {
    mode: "off",
    description: "Send the request exactly as written.",
    icon: OffIcon,
  },
  {
    mode: "simple",
    description: "Rewrite the request for clarity before the task starts.",
    icon: PromptEnhancementIcon,
  },
  {
    mode: "web-search",
    description:
      "Research current external context before rewriting when it matters.",
    icon: SearchIcon,
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
  const enhancementCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "chat.session.prompt-enhancement.select",
        title: "Choose prompt enhancement",
        group: "Chat",
        keywords: ["rewrite", "web search"],
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        children: () => ({
          id: "chat-prompt-enhancement",
          title: "Prompt enhancement",
          searchPlaceholder: "Choose prompt enhancement",
          numericSelection: true,
          groups: [
            {
              id: "enhancement",
              items: PROMPT_ENHANCEMENT_OPTIONS.map(
                (option, index): CommandPageItem => ({
                  id: option.mode,
                  title: PROMPT_ENHANCEMENT_LABELS[option.mode],
                  keywords: [option.description],
                  current: mode === option.mode,
                  numericKey: String(
                    index + 1,
                  ) as CommandPageItem["numericKey"],
                  availability:
                    option.mode === "web-search" && !webSearchAvailable
                      ? {
                          state: "disabled",
                          reason: webSearchUnavailableReason,
                        }
                      : { state: "enabled" },
                  execute: () => onModeChange(option.mode),
                }),
              ),
            },
          ],
        }),
      },
    ],
    [mode, onModeChange, webSearchAvailable, webSearchUnavailableReason],
  );
  useOptionalRegisterCommands(enhancementCommands);

  return (
    <Popover>
      <ControlTooltip content={`Prompt enhancement: ${activeLabel}`}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={`Prompt enhancement: ${activeLabel}`}
            data-active={active}
            className={cn(
              "app-prompt-enhancement-button app-composer-toolbar-control h-8 gap-0.5 rounded-full border p-0 shadow-none",
              mode === "web-search" ? "w-10" : "w-8",
            )}
          >
            <PromptEnhancementIcon className="h-3.5 w-3.5" />
            {mode === "web-search" ? (
              <SearchIcon
                aria-hidden="true"
                className="app-composer-mode-icon h-3 w-3"
              />
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
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                    disabled &&
                      "cursor-not-allowed border-dashed border-slate-800 bg-slate-950/40 text-slate-600 hover:border-slate-800 hover:bg-slate-950/40 hover:text-slate-600",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950",
                      selected ? "text-sky-200" : "text-slate-300",
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
                      {disabled
                        ? webSearchUnavailableReason
                        : option.description}
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
