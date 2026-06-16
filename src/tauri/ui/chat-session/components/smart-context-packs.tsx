import {
  AlertTriangle,
  Download,
  Layers,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useMemo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
} from "react";
import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import type {
  ChatSessionContextAttachment,
  SmartContextPack,
} from "../../chat-session.model";
import type { RalphFlow } from "../../../../core/ralph.js";
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
import { listRalphFlows, showRalphFlow } from "../../runtime";
import {
  createContextPackSummary,
  createSmartContextPackPreview,
  extractSmartContextPackVariables,
  getContextPackReasoningLabel,
  getContextPackModeLabel,
  getSmartContextPackMissingVariableNames,
  getSmartContextPackSortTimestamp,
  parseSmartContextPackListInput,
  type SaveSmartContextPackInput,
} from "../_helpers/smart-context-packs";

export interface SmartContextPackPickerProps {
  contextPacks: SmartContextPack[];
  workspaceRoot: string | null;
  activeDraft: string;
  activeProvider: RuntimeProvider;
  activeModel: string;
  activeRunMode: RunMode;
  activeReasoning: ReasoningMode;
  contextAttachments: ChatSessionContextAttachment[];
  matchedContextPackIds: string[];
  imageInputSupported: boolean;
  workspaceLabel: string;
  onSaveContextPack: (input: SaveSmartContextPackInput) => void;
  onApplyContextPack: (
    packId: string,
    variableValues?: Record<string, string>,
  ) => void | Promise<void>;
  onDeleteContextPack: (packId: string) => void;
  onExportContextPacks: () => void;
  onImportContextPacks: (file: File) => void;
}

type SmartContextPackView = "apply" | "save" | "configure";

interface SmartContextPackListItem {
  pack: SmartContextPack;
  summary: string[];
  preview: ReturnType<typeof createSmartContextPackPreview>;
  previewWarnings: string[];
  isMatched: boolean;
  ralphFlowNames: string[];
}

const PACK_FORM_CLASS =
  "grid max-h-[calc(100vh-8rem)] gap-3 overflow-y-auto p-3";

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

const formatListInputValue = (values: string[]): string => values.join(", ");

const isVariablePreviewWarning = (warning: string): boolean => {
  return warning.endsWith(" variable") || warning.endsWith(" variables");
};

const collectRalphFlowPackIds = (flow: RalphFlow): Set<string> => {
  const packIds = new Set<string>();

  for (const block of flow.blocks) {
    for (const packId of block.settings?.packs ?? []) {
      packIds.add(packId);
    }

    if (block.type === "PACK") {
      for (const packId of block.packIds) {
        packIds.add(packId);
      }
    }
  }

  return packIds;
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

const SmartContextPackCard = ({
  item,
  applyingPackId,
  pendingDeletePackId,
  onApplyPack,
  onDeleteContextPack,
}: {
  item: SmartContextPackListItem;
  applyingPackId: string | null;
  pendingDeletePackId: string | null;
  onApplyPack: (pack: SmartContextPack) => void;
  onDeleteContextPack: (pack: SmartContextPack) => void | Promise<void>;
}): JSX.Element => {
  const { pack, summary, preview, previewWarnings, isMatched, ralphFlowNames } =
    item;
  const isPendingUsedPackDelete =
    pendingDeletePackId === pack.id && ralphFlowNames.length > 0;

  return (
    <div
      className={cn(
        "grid gap-2 rounded-2xl border bg-slate-900/65 p-3 transition-colors",
        isMatched ? "border-sky-500/30 bg-sky-500/10" : "border-slate-800",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-slate-100">
              {pack.name}
            </p>
            {isMatched ? (
              <span className="inline-flex h-5 items-center gap-1 rounded-full border border-sky-400/25 bg-sky-400/10 px-1.5 text-[10px] font-semibold text-sky-100">
                <Sparkles className="h-3 w-3" />
                Suggested
              </span>
            ) : null}
          </div>
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
            disabled={applyingPackId !== null}
            onClick={() => onApplyPack(pack)}
            className="h-8 w-8 rounded-full border-sky-500/20 bg-sky-500/10 text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-600"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Delete context pack ${pack.name}`}
            title={`Delete ${pack.name}`}
            disabled={applyingPackId === pack.id}
            onClick={() => void onDeleteContextPack(pack)}
            className="h-8 w-8 rounded-full border-rose-500/20 bg-rose-500/10 text-rose-100 shadow-none hover:bg-rose-500/15 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-full border border-slate-700/80 bg-slate-950/70 px-2 py-0.5 text-[10px] leading-4 text-slate-400">
          ~{preview.estimatedTokens} tokens
        </span>
        <span className="rounded-full border border-slate-700/80 bg-slate-950/70 px-2 py-0.5 text-[10px] leading-4 text-slate-400">
          {preview.attachmentCount} path
          {preview.attachmentCount === 1 ? "" : "s"}
        </span>
        {previewWarnings.map((warning) => (
          <span
            key={warning}
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] leading-4 text-amber-100"
          >
            <AlertTriangle className="h-3 w-3" />
            {warning}
          </span>
        ))}
        {ralphFlowNames.length > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] leading-4 text-amber-100">
            <AlertTriangle className="h-3 w-3" />
            Used by {ralphFlowNames.length} Ralph flow
            {ralphFlowNames.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {isPendingUsedPackDelete ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
          This pack is used by {ralphFlowNames.join(", ")}. Click delete again to
          remove it anyway.
        </div>
      ) : null}
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
};

export const SmartContextPackPicker = ({
  contextPacks,
  workspaceRoot,
  activeDraft,
  activeProvider,
  activeModel,
  activeRunMode,
  activeReasoning,
  contextAttachments,
  matchedContextPackIds,
  imageInputSupported,
  workspaceLabel,
  onSaveContextPack,
  onApplyContextPack,
  onDeleteContextPack,
  onExportContextPacks,
  onImportContextPacks,
}: SmartContextPackPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SmartContextPackView>("apply");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [variablesInput, setVariablesInput] = useState("");
  const [triggerPhrasesInput, setTriggerPhrasesInput] = useState("");
  const [triggerPathPatternsInput, setTriggerPathPatternsInput] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [configuringPackId, setConfiguringPackId] = useState<string | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingPackId, setApplyingPackId] = useState<string | null>(null);
  const [pendingDeletePackId, setPendingDeletePackId] = useState<string | null>(null);
  const [ralphPackUsageById, setRalphPackUsageById] = useState<
    Record<string, string[]>
  >({});
  const [includePrompt, setIncludePrompt] = useState(false);
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [includeModel, setIncludeModel] = useState(true);
  const [includeMode, setIncludeMode] = useState(true);
  const [includeReasoning, setIncludeReasoning] = useState(true);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const hasPrompt = activeDraft.trim().length > 0;
  const hasAttachments = contextAttachments.length > 0;
  const currentModelLabel = `${getProviderLabel(activeProvider)} / ${activeModel}`;
  const currentModeLabel = getContextPackModeLabel(activeRunMode);
  const currentReasoningLabel = getContextPackReasoningLabel(activeReasoning);
  const attachmentToggleLabel = formatAttachmentToggleLabel(contextAttachments);
  const matchedPackIds = useMemo(
    () => new Set(matchedContextPackIds),
    [matchedContextPackIds],
  );
  const sortedPacks = useMemo(() => {
    return [...contextPacks].sort((left, right) => {
      return (
        getSmartContextPackSortTimestamp(right) -
        getSmartContextPackSortTimestamp(left)
      );
    });
  }, [contextPacks]);
  const packItems = useMemo<SmartContextPackListItem[]>(() => {
    return sortedPacks.map((pack) => {
      const preview = createSmartContextPackPreview(pack, {
        imageInputSupported,
      });

      return {
        pack,
        summary: createContextPackSummary(pack),
        preview,
        previewWarnings: preview.warnings.filter(
          (warning) => !isVariablePreviewWarning(warning),
        ),
        isMatched: matchedPackIds.has(pack.id),
        ralphFlowNames: ralphPackUsageById[pack.id] ?? [],
      };
    });
  }, [imageInputSupported, matchedPackIds, ralphPackUsageById, sortedPacks]);
  const configuringPack =
    configuringPackId === null
      ? null
      : (sortedPacks.find((pack) => pack.id === configuringPackId) ?? null);
  const missingVariableNames = configuringPack
    ? getSmartContextPackMissingVariableNames(configuringPack, variableValues)
    : [];
  const canSave =
    name.trim().length > 0 &&
    ((includePrompt && hasPrompt) ||
      (includeAttachments && hasAttachments) ||
      instructions.trim().length > 0 ||
      includeModel ||
      includeMode ||
      includeReasoning);

  const openSaveView = (): void => {
    setName(deriveContextPackName(activeDraft));
    setInstructions("");
    setIncludePrompt(hasPrompt);
    setIncludeAttachments(hasAttachments);
    setIncludeModel(true);
    setIncludeMode(true);
    setIncludeReasoning(true);
    setVariablesInput(
      formatListInputValue(extractSmartContextPackVariables(activeDraft)),
    );
    setTriggerPhrasesInput("");
    setTriggerPathPatternsInput("");
    setAutoApply(false);
    setView("save");
  };

  const openConfigureView = (pack: SmartContextPack): void => {
    setConfiguringPackId(pack.id);
    setApplyError(null);
    setVariableValues(
      Object.fromEntries(
        pack.variables.map((variable) => [
          variable.name,
          variable.defaultValue ?? "",
        ]),
      ),
    );
    setView("configure");
  };

  const applyPack = (pack: SmartContextPack): void => {
    if (applyingPackId) {
      return;
    }

    if (pack.variables.length > 0) {
      openConfigureView(pack);
      return;
    }

    setApplyingPackId(pack.id);
    void Promise.resolve()
      .then(() => onApplyContextPack(pack.id))
      .then(() => {
        setOpen(false);
      })
      .catch((error) => {
        console.error("Failed to apply context pack", error);
      })
      .finally(() => {
        setApplyingPackId(null);
      });
  };

  const loadRalphPackUsage = async (): Promise<Record<string, string[]>> => {
    if (!workspaceRoot) {
      return {};
    }

    const nextUsage: Record<string, string[]> = {};
    const flowList = await listRalphFlows(workspaceRoot);

    for (const summary of flowList.flows) {
      const flowResult = await showRalphFlow(workspaceRoot, summary.id);
      const packIds = collectRalphFlowPackIds(flowResult.flow);

      for (const packId of packIds) {
        nextUsage[packId] = [
          ...(nextUsage[packId] ?? []),
          flowResult.flow.name || flowResult.flow.id,
        ];
      }
    }

    return nextUsage;
  };

  useEffect(() => {
    if (!open || !workspaceRoot) {
      setRalphPackUsageById({});
      setPendingDeletePackId(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const nextUsage = await loadRalphPackUsage();

      if (!cancelled) {
        setRalphPackUsageById(nextUsage);
      }
    })().catch(() => {
      if (!cancelled) {
        setRalphPackUsageById({});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, workspaceRoot]);

  const requestDeletePack = async (pack: SmartContextPack): Promise<void> => {
    let latestUsage = ralphPackUsageById;

    try {
      latestUsage = await loadRalphPackUsage();
      setRalphPackUsageById(latestUsage);
    } catch {
      // Keep the last known usage map if the refresh fails.
    }

    const ralphFlowNames = latestUsage[pack.id] ?? [];

    if (ralphFlowNames.length > 0 && pendingDeletePackId !== pack.id) {
      setPendingDeletePackId(pack.id);
      return;
    }

    setPendingDeletePackId(null);
    onDeleteContextPack(pack.id);
  };

  const handleSave = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!canSave) {
      return;
    }

    onSaveContextPack({
      name,
      instructions,
      variables: [
        ...parseSmartContextPackListInput(variablesInput),
        ...extractSmartContextPackVariables(
          name,
          instructions,
          includePrompt ? activeDraft : "",
        ),
      ],
      triggerPhrases: parseSmartContextPackListInput(triggerPhrasesInput),
      triggerPathPatterns: parseSmartContextPackListInput(
        triggerPathPatternsInput,
      ),
      autoApply,
      includePrompt,
      includeAttachments,
      includeModel,
      includeMode,
      includeReasoning,
    });
    setOpen(false);
    setView("apply");
  };

  const handleConfiguredApply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!configuringPack) {
      return;
    }

    if (missingVariableNames.length > 0) {
      setApplyError(`Required: ${missingVariableNames.join(", ")}`);
      return;
    }

    setApplyingPackId(configuringPack.id);
    void Promise.resolve()
      .then(() => onApplyContextPack(configuringPack.id, variableValues))
      .then(() => {
        setOpen(false);
        setView("apply");
        setConfiguringPackId(null);
        setVariableValues({});
        setApplyError(null);
      })
      .catch((error) => {
        console.error("Failed to apply context pack", error);
        setApplyError("Could not apply this pack.");
      })
      .finally(() => {
        setApplyingPackId(null);
      });
  };

  const handleImportFileChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const [file] = Array.from(event.target.files ?? []);

    if (file) {
      onImportContextPacks(file);
    }

    event.target.value = "";
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);

        if (!nextOpen) {
          setView("apply");
          setConfiguringPackId(null);
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
        className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border-slate-800 bg-slate-950/98 p-0 shadow-xl shadow-slate-950/40 backdrop-blur-xl"
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
            <div className="flex shrink-0 items-center gap-1.5">
              <input
                ref={importInputRef}
                type="file"
                aria-label="Context pack import file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportFileChange}
              />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Import context packs"
                title="Import context packs"
                onClick={() => importInputRef.current?.click()}
                className="h-8 w-8 rounded-full border-slate-800 bg-slate-900/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"
              >
                <Upload className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Export context packs"
                title="Export context packs"
                disabled={contextPacks.length === 0}
                onClick={onExportContextPacks}
                className="h-8 w-8 rounded-full border-slate-800 bg-slate-900/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:text-slate-600"
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
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
        </div>

        {view === "apply" ? (
          <div className="grid max-h-[26rem] gap-2 overflow-y-auto p-3">
            {packItems.length === 0 ? (
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

            {packItems.map((item) => (
              <SmartContextPackCard
                key={item.pack.id}
                item={item}
                applyingPackId={applyingPackId}
                pendingDeletePackId={pendingDeletePackId}
                onApplyPack={applyPack}
                onDeleteContextPack={requestDeletePack}
              />
            ))}
          </div>
        ) : view === "save" ? (
          <form
            className={PACK_FORM_CLASS}
            onSubmit={handleSave}
          >
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

            <label className="grid gap-1.5">
              <span className="px-1 text-xs font-medium text-slate-400">
                Variables
              </span>
              <Input
                value={variablesInput}
                onChange={(event) => setVariablesInput(event.target.value)}
                placeholder="ticket_id, target_file, test_command"
                className="h-9 rounded-xl border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
              />
            </label>

            <div className="grid gap-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-3">
              <label className="grid gap-1.5">
                <span className="px-1 text-xs font-medium text-slate-400">
                  Trigger phrases
                </span>
                <Input
                  value={triggerPhrasesInput}
                  onChange={(event) => setTriggerPhrasesInput(event.target.value)}
                  placeholder="review pr, frontend qa, debug build"
                  className="h-9 rounded-xl border-slate-800 bg-slate-950/60 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                />
              </label>

              <label className="grid gap-1.5">
                <span className="px-1 text-xs font-medium text-slate-400">
                  Path patterns
                </span>
                <Input
                  value={triggerPathPatternsInput}
                  onChange={(event) =>
                    setTriggerPathPatternsInput(event.target.value)
                  }
                  placeholder="*.tsx, src/ui/**, package.json"
                  className="h-9 rounded-xl border-slate-800 bg-slate-950/60 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                />
              </label>

              <PackOption
                label="Auto-apply matching pack"
                checked={autoApply}
                onChange={setAutoApply}
              />
            </div>

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
                <PackOption
                  label={currentReasoningLabel}
                  checked={includeReasoning}
                  onChange={setIncludeReasoning}
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
        ) : configuringPack ? (
          <form
            className={PACK_FORM_CLASS}
            onSubmit={handleConfiguredApply}
          >
            <div className="grid gap-1">
              <p className="text-sm font-semibold text-slate-100">
                {configuringPack.name}
              </p>
              <p className="text-xs leading-5 text-slate-500">
                Fill variables before applying this pack.
              </p>
              {applyError ? (
                <p className="text-xs leading-5 text-amber-100">
                  {applyError}
                </p>
              ) : null}
            </div>

            <div className="grid max-h-64 gap-2 overflow-y-auto pr-1">
              {configuringPack.variables.map((variable) => (
                <label key={variable.name} className="grid gap-1.5">
                  <span className="px-1 text-xs font-medium text-slate-400">
                    {variable.name}
                  </span>
                  <Input
                    value={variableValues[variable.name] ?? ""}
                    onChange={(event) =>
                      setVariableValues((prev) => ({
                        ...prev,
                        [variable.name]: event.target.value,
                      }))
                    }
                    onFocus={() => setApplyError(null)}
                    placeholder={variable.defaultValue ?? variable.name}
                    className="h-9 rounded-xl border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                  />
                </label>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 pt-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setView("apply");
                  setConfiguringPackId(null);
                  setVariableValues({});
                  setApplyError(null);
                }}
                className="h-8 rounded-full px-3 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                Back
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={
                  missingVariableNames.length > 0 ||
                  applyingPackId === configuringPack.id
                }
                className="h-8 rounded-full border-sky-500/20 bg-sky-500/10 px-3 text-xs text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-600"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Apply pack
              </Button>
            </div>
          </form>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
