import { CircleAlert } from "lucide-react";
import type {
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
} from "../../../../core/media/contracts.js";
import { getMissingMediaModelAddonTriggers } from "../../../../core/media/model-addons.js";

export const MediaAddonTriggerWarnings = ({
  prompt,
  sourcePrompt = prompt,
  addons,
  selections,
  onPromptChange,
  disabled = false,
}: {
  prompt: string;
  sourcePrompt?: string;
  addons: readonly MediaModelAddonDescriptor[];
  selections: readonly MediaModelAddonSelection[];
  onPromptChange: (prompt: string) => void;
  disabled?: boolean;
}) =>
  getMissingMediaModelAddonTriggers(prompt, addons, selections).map(
    ({ addon, trigger }) => (
      <div
        key={addon.id}
        className="flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2"
      >
        <CircleAlert className="h-4 w-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1 text-xs text-amber-100">
          Missing “{trigger}”
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onPromptChange(
              sourcePrompt.trim()
                ? `${sourcePrompt.trim()}, ${trigger}`
                : trigger,
            )
          }
          className="shrink-0 text-xs font-medium text-amber-200 hover:text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
    ),
  );
