import { Bot } from "lucide-react";
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
  getCatalogModelsForProvider,
  getProviderLabel,
  type RuntimeProvider,
} from "../../model-catalog";
import {
  MODEL_STAGE_CLASSES,
  MODEL_STAGE_LABELS,
} from "../_helpers/session-shell";

export interface SessionModelPickerProps {
  chooserProviders: RuntimeProvider[];
  activeProvider: RuntimeProvider;
  activeModel: string;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
}

export const SessionModelPicker = ({
  chooserProviders,
  activeProvider,
  activeModel,
  onSessionModelSelection,
}: SessionModelPickerProps): JSX.Element => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={chooserProviders.length === 0}
          className="h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:opacity-50"
        >
          <Bot className="mr-2 h-3.5 w-3.5 text-slate-500" />
          {getProviderLabel(activeProvider)} · {activeModel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[30rem] rounded-3xl border-slate-800 bg-slate-950/95 p-5 shadow-2xl backdrop-blur-xl"
      >
        <div className="grid gap-4">
          <div className="grid gap-1">
            <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
              Session model
            </p>
            <p className="text-sm leading-6 text-slate-400">
              Each session keeps its own model, and new sessions reuse the last
              model you selected.
            </p>
          </div>

          {chooserProviders.map((provider) => (
            <div key={provider} className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">
                  {getProviderLabel(provider)}
                </p>
                {activeProvider === provider ? (
                  <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-200">
                    Current provider
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {getCatalogModelsForProvider(provider).map((model) => (
                  <button
                    key={`${provider}-${model.id}`}
                    type="button"
                    onClick={() => onSessionModelSelection(provider, model.id)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-left text-xs transition-all",
                      activeProvider === provider && activeModel === model.id
                        ? "border-sky-500/30 bg-sky-500/12 text-sky-100"
                        : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700 hover:text-slate-200",
                    )}
                  >
                    <span className="font-semibold">{model.label}</span>
                    <span
                      className={cn(
                        "ml-2 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        MODEL_STAGE_CLASSES[model.stage],
                      )}
                    >
                      {MODEL_STAGE_LABELS[model.stage]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
