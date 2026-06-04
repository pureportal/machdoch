import {
  Layers,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import {
  useMemo,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import type { RunMode } from "../../../../core/types.js";
import type {
  ChatSessionContextAttachment,
  SmartContextPack,
} from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { getProviderLabel, type RuntimeProvider } from "../../model-catalog";
import {
  createContextPackSummary,
  getContextPackModeLabel,
  getSmartContextPackSortTimestamp,
  type SaveSmartContextPackInput,
} from "../_helpers/smart-context-packs";

export interface SmartContextPackPickerProps {
  contextPacks: SmartContextPack[];
  activeDraft: string;
  activeProvider: RuntimeProvider;
  activeModel: string;
  activeRunMode: RunMode;
  contextAttachments: ChatSessionContextAttachment[];
  workspaceLabel: string;
  onSaveContextPack: (input: SaveSmartContextPackInput) => void;
  onApplyContextPack: (packId: string) => void;
  onDeleteContextPack: (packId: string) => void;
}

type SmartContextPackView = "apply" | "save";

const deriveContextPackName = (draft: string): string => {
  const normalizedDraft = draft.replace(/\s+/gu, " ").trim();

  if (!normalizedDraft) {
    return "";
  }

  return normalizedDraft.length <= 40
    ? normalizedDraft
    : `${normalizedDraft.slice(0, 37)}...`;
};

const formatPackUsage = (pack: SmartContextPack): string => {
  if (pack.useCount <= 0) {
    return "Not used";
  }

  return `${pack.useCount} use${pack.useCount === 1 ? "" : "s"}`;
};

const formatAttachmentToggleLabel = (
  attachments: ChatSessionContextAttachment[],
): string => {
  const count = attachments.length;

  return `${count} path${count === 1 ? "" : "s"}`;
};

const PackOption = ({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element => {
  return (
    <label
      className={cn(
        "flex h-8 items-center gap-2 rounded-full border border-slate-800 bg-slate-900/70 px-3 text-xs font-medium text-slate-300",
        disabled
          ? "cursor-not-allowed opacity-45"
          : "cursor-pointer hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-950 text-sky-400 accent-sky-400"
      />
      <span className="truncate">{label}</span>
    </label>
  );
};

export const SmartContextPackPicker = ({
  contextPacks,
  activeDraft,
  activeProvider,
  activeModel,
  activeRunMode,
  contextAttachments,
  workspaceLabel,
  onSaveContextPack,
  onApplyContextPack,
  onDeleteContextPack,
}: SmartContextPackPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SmartContextPackView>("apply");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [includePrompt, setIncludePrompt] = useState(false);
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [includeModel, setIncludeModel] = useState(true);
  const [includeMode, setIncludeMode] = useState(true);
  const hasPrompt = activeDraft.trim().length > 0;
  const hasAttachments = contextAttachments.length > 0;
  const currentModelLabel = `${getProviderLabel(activeProvider)} / ${activeModel}`;
  const currentModeLabel = getContextPackModeLabel(activeRunMode);
  const attachmentToggleLabel = formatAttachmentToggleLabel(contextAttachments);
  const sortedPacks = useMemo(() => {
    return [...contextPacks].sort((left, right) => {
      return (
        getSmartContextPackSortTimestamp(right) -
        getSmartContextPackSortTimestamp(left)
      );
    });
  }, [contextPacks]);
  const canSave =
    name.trim().length > 0 &&
    ((includePrompt && hasPrompt) ||
      (includeAttachments && hasAttachments) ||
      instructions.trim().length > 0 ||
      includeModel ||
      includeMode);

  const openSaveView = (): void => {
    setName(deriveContextPackName(activeDraft));
    setInstructions("");
    setIncludePrompt(hasPrompt);
    setIncludeAttachments(hasAttachments);
    setIncludeModel(true);
    setIncludeMode(true);
    setView("save");
  };

  const handleSave = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!canSave) {
      return;
    }

    onSaveContextPack({
      name,
      instructions,
      includePrompt,
      includeAttachments,
      includeModel,
      includeMode,
    });
    setOpen(false);
    setView("apply");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);

        if (!nextOpen) {
          setView("apply");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label="Context packs"
          title="Context packs"
          className="app-context-pack-trigger h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:border-sky-500/30 hover:bg-slate-900 hover:text-slate-100"
        >
          <Layers className="h-3.5 w-3.5 text-sky-300" />
          <span className="hidden sm:inline">Packs</span>
          {contextPacks.length > 0 ? (
            <span className="rounded-full border border-slate-700 bg-slate-900 px-1.5 text-[10px] leading-4 text-slate-400">
              {contextPacks.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border-slate-800 bg-slate-950/98 p-0 shadow-2xl shadow-sky-950/30 backdrop-blur-xl"
      >
        <div className="border-b border-slate-800/80 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.16em] text-slate-500 uppercase">
                Context packs
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-100">
                {workspaceLabel}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openSaveView}
              className="h-8 rounded-full border-sky-500/20 bg-sky-500/10 px-3 text-xs text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        </div>

        {view === "apply" ? (
          <div className="grid max-h-[26rem] gap-2 overflow-y-auto p-3">
            {sortedPacks.length === 0 ? (
              <button
                type="button"
                onClick={openSaveView}
                className="grid gap-2 rounded-2xl border border-dashed border-slate-800 bg-slate-900/45 px-4 py-5 text-left text-slate-300 hover:border-sky-500/30 hover:bg-sky-500/10 hover:text-sky-100"
              >
                <span className="text-sm font-semibold">Save current setup</span>
                <span className="text-xs leading-5 text-slate-500">
                  Prompt, instructions, paths, model, and mode.
                </span>
              </button>
            ) : null}

            {sortedPacks.map((pack) => {
              const summary = createContextPackSummary(pack);

              return (
                <div
                  key={pack.id}
                  className="grid gap-2 rounded-2xl border border-slate-800 bg-slate-900/65 p-3"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-100">
                        {pack.name}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {formatPackUsage(pack)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={`Apply context pack ${pack.name}`}
                        title={`Apply ${pack.name}`}
                        onClick={() => {
                          onApplyContextPack(pack.id);
                          setOpen(false);
                        }}
                        className="h-8 w-8 rounded-full border-sky-500/20 bg-sky-500/10 text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={`Delete context pack ${pack.name}`}
                        title={`Delete ${pack.name}`}
                        onClick={() => onDeleteContextPack(pack.id)}
                        className="h-8 w-8 rounded-full border-rose-500/20 bg-rose-500/10 text-rose-100 shadow-none hover:bg-rose-500/15 hover:text-white"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {summary.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {summary.map((entry) => (
                        <span
                          key={entry}
                          className="max-w-full truncate rounded-full border border-slate-700/80 bg-slate-950/70 px-2 py-0.5 text-[10px] leading-4 text-slate-400"
                        >
                          {entry}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <form className="grid gap-3 p-3" onSubmit={handleSave}>
            <label className="grid gap-1.5">
              <span className="px-1 text-xs font-medium text-slate-400">
                Name
              </span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Review PR"
                className="h-9 rounded-xl border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="px-1 text-xs font-medium text-slate-400">
                Instructions
              </span>
              <Textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Focus on regressions, missing tests, and user-facing risk."
                className="min-h-20 resize-none rounded-xl border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
              />
            </label>

            <div className="grid gap-2">
              <div className="flex flex-wrap gap-2">
                <PackOption
                  label="Prompt"
                  checked={includePrompt}
                  disabled={!hasPrompt}
                  onChange={setIncludePrompt}
                />
                <PackOption
                  label={attachmentToggleLabel}
                  checked={includeAttachments}
                  disabled={!hasAttachments}
                  onChange={setIncludeAttachments}
                />
                <PackOption
                  label={currentModelLabel}
                  checked={includeModel}
                  onChange={setIncludeModel}
                />
                <PackOption
                  label={currentModeLabel}
                  checked={includeMode}
                  onChange={setIncludeMode}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 pt-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setView("apply")}
                className="h-8 rounded-full px-3 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                Back
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={!canSave}
                className="h-8 rounded-full border-sky-500/20 bg-sky-500/10 px-3 text-xs text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-600"
              >
                <Save className="h-3.5 w-3.5" />
                Save pack
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
};
