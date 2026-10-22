import {
  SmartContextPackEditorDialog,
  type SmartContextPackEditorInitialValue,
  type PackModelOption,
} from "./editor";
import { ContextPacksIcon } from "@machdoch/product-ui";
import {
  Download,
  Folder,
  Globe2,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  type ReasoningMode,
  type RunMode,
  type RuntimeProvider,
} from "@machdoch/fleet-protocol/runtime-options";
import { type SmartContextPack } from "@machdoch/client-ui/context-packs/model";
import { type ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";

import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import type {
  CommandDefinition,
  CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

import { type PromptEnhancementMode } from "../composer/prompt-enhancement-options";
import {
  extractSmartContextPackVariables,
  getSmartContextPackMissingVariableNames,
  getSmartContextPackScope,
  getSmartContextPackScopeLabel,
  getSmartContextPackSortTimestamp,
} from "@machdoch/client-ui/context-packs/helpers";
import {
  type SaveSmartContextPackInput,
  type SmartContextPackScope,
  type SmartContextPackScopeFilter,
} from "@machdoch/client-ui/context-packs/model";

export interface SmartContextPackPickerProps {
  disabled?: boolean;
  loadRalphPackUsage: (
    workspaceRoot: string,
  ) => Promise<Record<string, string[]>>;
  contextPacks: SmartContextPack[];
  modelOptions?: PackModelOption[];
  workspaceRoot: string | null;
  activeDraft: string;
  activeProvider: RuntimeProvider;
  activeModel: string;
  activeRunMode: RunMode;
  activeReasoning: ReasoningMode;
  activeContextWindow?: import("@machdoch/fleet-protocol/context-window").ContextWindow;
  activePromptEnhancementMode: PromptEnhancementMode;
  activeInterviewEnabled: boolean;
  activeSessionMemoryEnabled: boolean;
  activeUseGlobalMemory: boolean;
  activeUseWorkspaceMemory?: boolean;
  activeUiControlEnabled: boolean;
  contextAttachments: ChatSessionContextAttachment[];
  matchedContextPackIds: string[];
  imageInputSupported: boolean;
  workspaceLabel: string;
  onSaveContextPack: (input: SaveSmartContextPackInput) => void | Promise<void>;
  onApplyContextPack: (
    packId: string,
    variableValues?: Record<string, string>,
  ) => void | Promise<void>;
  onDeleteContextPack: (packId: string) => void | Promise<void>;
  onExportContextPacks: (scopeFilter: SmartContextPackScopeFilter) => void;
  onImportContextPacks: (
    file: File,
    scope: SmartContextPackScope,
  ) => void | Promise<void>;
}

type SmartContextPackView = "apply" | "configure";

interface SmartContextPackListItem {
  pack: SmartContextPack;
  scope: SmartContextPackScope;
  isMatched: boolean;
  ralphFlowNames: string[];
}

interface SmartContextPackDialogState {
  key: string;
  initialValue: SmartContextPackEditorInitialValue;
}

const PACK_FORM_CLASS = "grid gap-4";

const deriveContextPackName = (draft: string): string => {
  const normalizedDraft = draft.replace(/\s+/gu, " ").trim();

  if (!normalizedDraft) {
    return "";
  }

  return normalizedDraft.length <= 40
    ? normalizedDraft
    : `${normalizedDraft.slice(0, 37)}...`;
};

const normalizeContextPackSearchText = (value: string): string => {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
};

const tokenizeContextPackSearchText = (value: string): string[] => {
  const normalized = normalizeContextPackSearchText(value);
  return normalized ? normalized.split(" ") : [];
};

const scoreNormalizedContextPackCandidate = (
  normalizedCandidate: string,
  normalizedQuery: string,
  tokens: readonly string[],
  labelBonus: number,
): number => {
  if (!normalizedCandidate) {
    return 0;
  }

  const words = normalizedCandidate.split(" ");
  let score = 0;

  for (const token of tokens) {
    if (normalizedCandidate === token) {
      score += 500;
      continue;
    }

    if (normalizedCandidate.startsWith(token)) {
      score += 420;
      continue;
    }

    if (words.includes(token)) {
      score += 360;
      continue;
    }

    if (words.some((word) => word.startsWith(token))) {
      score += 300;
      continue;
    }

    const tokenIndex = normalizedCandidate.indexOf(token);

    if (tokenIndex < 0) {
      return 0;
    }

    score += 160 - Math.min(tokenIndex, 100);
  }

  if (normalizedCandidate === normalizedQuery) {
    return score + 800 + labelBonus;
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return score + 620 + labelBonus;
  }

  const phraseIndex = normalizedCandidate.indexOf(normalizedQuery);

  if (phraseIndex >= 0) {
    return score + 420 - Math.min(phraseIndex, 100) + labelBonus;
  }

  return score + labelBonus;
};

const scoreContextPackSearchItem = (
  item: SmartContextPackListItem,
  searchText: string,
): number => {
  const normalizedQuery = normalizeContextPackSearchText(searchText);
  const tokens = tokenizeContextPackSearchText(searchText);

  if (!normalizedQuery || tokens.length === 0) {
    return 0;
  }

  const { pack } = item;
  const nameScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.name),
    normalizedQuery,
    tokens,
    160,
  );
  const triggerScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.trigger.phrases.join(" ")),
    normalizedQuery,
    tokens,
    80,
  );
  const promptScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.prompt),
    normalizedQuery,
    tokens,
    20,
  );
  const instructionsScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.instructions),
    normalizedQuery,
    tokens,
    20,
  );

  return Math.max(nameScore, triggerScore, promptScore, instructionsScore);
};

const formatScopeFilterLabel = (
  scopeFilter: SmartContextPackScopeFilter,
): string => {
  switch (scopeFilter) {
    case "global":
      return "Global";
    case "workspace":
      return "Workspace";
    case "all":
    default:
      return "All";
  }
};

const SmartContextPackCard = ({
  item,
  applyingPackId,
  pendingDeletePackId,
  onEditPack,
  onApplyPack,
  onDeleteContextPack,
}: {
  item: SmartContextPackListItem;
  applyingPackId: string | null;
  pendingDeletePackId: string | null;
  onEditPack: (pack: SmartContextPack) => void;
  onApplyPack: (pack: SmartContextPack) => void;
  onDeleteContextPack: (pack: SmartContextPack) => void | Promise<void>;
}): JSX.Element => {
  const { pack, isMatched, ralphFlowNames } = item;
  const scopeLabel = getSmartContextPackScopeLabel(item.scope);
  const isPendingUsedPackDelete =
    pendingDeletePackId === pack.id && ralphFlowNames.length > 0;

  return (
    <div
      className={cn(
        "rounded-xl border bg-slate-900/55 px-2.5 py-1.5 transition-colors",
        isMatched ? "border-sky-500/30 bg-sky-500/10" : "border-slate-800/90",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
            {pack.name}
          </p>
          <ControlTooltip content={`${scopeLabel} context pack`}>
            <span
              role="img"
              aria-label={`${scopeLabel} context pack`}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-800/80 bg-slate-950/60"
            >
              {item.scope === "global" ? (
                <Globe2 className="h-3 w-3 text-emerald-200" />
              ) : (
                <Folder className="h-3 w-3 text-slate-400" />
              )}
            </span>
          </ControlTooltip>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Edit context pack ${pack.name}`}
            tooltip={`Edit ${pack.name}`}
            disabled={applyingPackId !== null}
            onClick={() => onEditPack(pack)}
            className="h-7 w-7 rounded-full border-slate-800 bg-transparent text-slate-400 shadow-none hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100 disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Apply context pack ${pack.name}`}
            tooltip={`Apply ${pack.name}`}
            disabled={applyingPackId !== null}
            onClick={() => onApplyPack(pack)}
            className="h-7 w-7 rounded-full border-sky-500/20 bg-sky-500/10 text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Play className="h-3 w-3 fill-current" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Delete context pack ${pack.name}`}
            tooltip={`Delete ${pack.name}`}
            disabled={applyingPackId === pack.id}
            onClick={() => void onDeleteContextPack(pack)}
            className="h-7 w-7 rounded-full border-rose-500/20 bg-transparent text-rose-200 shadow-none hover:bg-rose-500/10 hover:text-white disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {isPendingUsedPackDelete ? (
        <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-xs leading-5 text-amber-100">
          This pack is used by {ralphFlowNames.join(", ")}. Click delete again
          to remove it anyway.
        </div>
      ) : null}
    </div>
  );
};

export const SmartContextPackPicker = ({
  disabled = false,
  loadRalphPackUsage: loadUsage,
  contextPacks,
  modelOptions,
  workspaceRoot,
  activeDraft,
  activeProvider,
  activeModel,
  activeRunMode,
  activeReasoning,
  activeContextWindow,
  activePromptEnhancementMode,
  activeInterviewEnabled,
  activeSessionMemoryEnabled,
  activeUseGlobalMemory,
  activeUseWorkspaceMemory,
  activeUiControlEnabled,
  contextAttachments,
  matchedContextPackIds,
  workspaceLabel,
  onSaveContextPack,
  onApplyContextPack,
  onDeleteContextPack,
  onExportContextPacks,
  onImportContextPacks,
}: SmartContextPackPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SmartContextPackView>("apply");
  const [packDialog, setPackDialog] =
    useState<SmartContextPackDialogState | null>(null);
  const [scopeFilter, setScopeFilter] =
    useState<SmartContextPackScopeFilter>("all");
  const [packSearchText, setPackSearchText] = useState("");
  const [configuringPackId, setConfiguringPackId] = useState<string | null>(
    null,
  );
  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    {},
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingPackId, setApplyingPackId] = useState<string | null>(null);
  const [pendingDeletePackId, setPendingDeletePackId] = useState<string | null>(
    null,
  );
  const [ralphPackUsageById, setRalphPackUsageById] = useState<
    Record<string, string[]>
  >({});
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importScopeRef = useRef<SmartContextPackScope | null>(null);
  const packSearchInputRef = useRef<HTMLInputElement | null>(null);
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
    return sortedPacks.map((pack) => ({
      pack,
      scope: getSmartContextPackScope(pack),
      isMatched: matchedPackIds.has(pack.id),
      ralphFlowNames: ralphPackUsageById[pack.id] ?? [],
    }));
  }, [matchedPackIds, ralphPackUsageById, sortedPacks]);
  const scopedPackItems = useMemo(
    () =>
      packItems.filter(
        (item) => scopeFilter === "all" || item.scope === scopeFilter,
      ),
    [packItems, scopeFilter],
  );
  const visiblePackItems = useMemo<SmartContextPackListItem[]>(() => {
    if (!packSearchText.trim()) {
      return scopedPackItems;
    }

    return scopedPackItems
      .map((item, order) => ({
        item,
        order,
        score: scoreContextPackSearchItem(item, packSearchText),
      }))
      .filter((entry) => entry.score > 0)
      .sort((firstEntry, secondEntry) => {
        const scoreDifference = secondEntry.score - firstEntry.score;

        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return firstEntry.order - secondEntry.order;
      })
      .map((entry) => entry.item);
  }, [packSearchText, scopedPackItems]);
  const workspacePackCount = packItems.filter(
    (item) => item.scope === "workspace",
  ).length;
  const globalPackCount = packItems.filter(
    (item) => item.scope === "global",
  ).length;
  const configuringPack =
    configuringPackId === null
      ? null
      : (sortedPacks.find((pack) => pack.id === configuringPackId) ?? null);
  const missingVariableNames = configuringPack
    ? getSmartContextPackMissingVariableNames(configuringPack, variableValues)
    : [];

  const handlePopoverOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);

    if (nextOpen) {
      setView("apply");
      setPackSearchText("");
      return;
    }

    setView("apply");
    setConfiguringPackId(null);
    setPackSearchText("");
  };

  const openCreateDialog = useCallback((): void => {
    const nextScope =
      !workspaceRoot || scopeFilter === "global" ? "global" : "workspace";

    setPackDialog({
      key: `create-${Date.now()}`,
      initialValue: {
        mode: "create",
        name: deriveContextPackName(activeDraft),
        scope: nextScope,
        instructions: "",
        prompt: activeDraft,
        contextAttachments,
        variables: extractSmartContextPackVariables(activeDraft).map(
          (name) => ({
            name,
          }),
        ),
        triggerPhrases: [],
        triggerPathPatterns: [],
        provider: activeProvider,
        model: activeModel,
        runMode: activeRunMode,
        reasoning: activeReasoning,
          contextWindow: activeContextWindow,
        promptEnhancementMode: activePromptEnhancementMode,
        interviewEnabled: activeInterviewEnabled,
        sessionMemoryEnabled: activeSessionMemoryEnabled,
        useGlobalMemory: activeUseGlobalMemory,
        useWorkspaceMemory: activeUseWorkspaceMemory,
        uiControlEnabled: activeUiControlEnabled,
      },
    });
    setOpen(false);
    setView("apply");
    setPackSearchText("");
  }, [
    activeDraft,
    activeInterviewEnabled,
    activeModel,
    activePromptEnhancementMode,
    activeProvider,
    activeReasoning,
    activeRunMode,
    activeContextWindow,
    activeSessionMemoryEnabled,
    activeUiControlEnabled,
    activeUseGlobalMemory,
    activeUseWorkspaceMemory,
    contextAttachments,
    scopeFilter,
    workspaceRoot,
  ]);

  const openEditDialog = useCallback((pack: SmartContextPack): void => {
    setPackDialog({
      key: `edit-${pack.id}-${Date.now()}`,
      initialValue: {
        id: pack.id,
        temporary: pack.temporary,
        useWorkspaceMemory: pack.useWorkspaceMemory,
        mode: "edit",
        name: pack.name,
        scope: getSmartContextPackScope(pack),
        instructions: pack.instructions,
        prompt: pack.prompt,
        contextAttachments: pack.contextAttachments,
        variables: pack.variables,
        triggerPhrases: pack.trigger.phrases,
        triggerPathPatterns: pack.trigger.pathPatterns,
        ...(pack.provider ? { provider: pack.provider } : {}),
        ...(pack.model ? { model: pack.model } : {}),
        ...(pack.mode ? { runMode: pack.mode } : {}),
        ...(pack.reasoning ? { reasoning: pack.reasoning } : {}),
          ...(pack.contextWindow !== undefined ? { contextWindow: pack.contextWindow } : {}),
        ...(pack.promptEnhancementMode !== undefined
          ? { promptEnhancementMode: pack.promptEnhancementMode }
          : {}),
        ...(pack.interviewEnabled !== undefined
          ? { interviewEnabled: pack.interviewEnabled }
          : {}),
        ...(pack.sessionMemoryEnabled !== undefined
          ? { sessionMemoryEnabled: pack.sessionMemoryEnabled }
          : {}),
        ...(pack.useGlobalMemory !== undefined
          ? { useGlobalMemory: pack.useGlobalMemory }
          : {}),
        ...(pack.uiControlEnabled !== undefined
          ? { uiControlEnabled: pack.uiControlEnabled }
          : {}),
      },
    });
    setOpen(false);
    setView("apply");
    setPackSearchText("");
  }, []);

  const handlePackDialogSubmit = async (
    input: SaveSmartContextPackInput,
  ): Promise<void> => {
    await onSaveContextPack(input);
    setPackDialog(null);
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

  const applyPack = useCallback(
    (pack: SmartContextPack): void => {
      if (applyingPackId) {
        return;
      }

      if (pack.variables.length > 0) {
        openConfigureView(pack);
        setOpen(true);
        return;
      }

      setApplyingPackId(pack.id);
      void Promise.resolve()
        .then(() => onApplyContextPack(pack.id))
        .then(() => {
          setOpen(false);
          setPackSearchText("");
        })
        .catch((error) => {
          console.error("Failed to apply context pack", error);
        })
        .finally(() => {
          setApplyingPackId(null);
        });
    },
    [applyingPackId, onApplyContextPack],
  );

  const handlePackSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || !packSearchText.trim()) {
      return;
    }

    const bestMatch = visiblePackItems[0];

    if (!bestMatch) {
      return;
    }

    event.preventDefault();
    applyPack(bestMatch.pack);
  };

  const loadRalphPackUsage = useCallback(async (): Promise<
    Record<string, string[]>
  > => {
    if (!workspaceRoot) {
      return {};
    }

    return loadUsage(workspaceRoot);
  }, [workspaceRoot, loadUsage]);

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
    })().catch((reason: unknown) => {
      if (!cancelled) {
        setApplyError(
          reason instanceof Error ? reason.message : String(reason),
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadRalphPackUsage, open, workspaceRoot]);

  const requestDeletePack = useCallback(
    async (pack: SmartContextPack): Promise<void> => {
      let latestUsage = ralphPackUsageById;

      try {
        latestUsage = await loadRalphPackUsage();
        setRalphPackUsageById(latestUsage);
      } catch (reason: unknown) {
        setApplyError(
          reason instanceof Error ? reason.message : String(reason),
        );
        setOpen(true);
        return;
      }

      const ralphFlowNames = latestUsage[pack.id] ?? [];

      if (ralphFlowNames.length > 0 && pendingDeletePackId !== pack.id) {
        if (!open) {
          setScopeFilter(getSmartContextPackScope(pack));
          setPackSearchText("");
        }
        setPendingDeletePackId(pack.id);
        setOpen(true);
        return;
      }

      setPendingDeletePackId(null);
      try {
        await onDeleteContextPack(pack.id);
      } catch (reason: unknown) {
        setApplyError(
          reason instanceof Error ? reason.message : String(reason),
        );
        setOpen(true);
      }
    },
    [
      loadRalphPackUsage,
      onDeleteContextPack,
      open,
      pendingDeletePackId,
      ralphPackUsageById,
    ],
  );

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
        setPackSearchText("");
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
      if (importScopeRef.current === null) {
        console.error("No context pack import scope selected");
      } else {
        const scope = importScopeRef.current;
        void Promise.resolve()
          .then(() => onImportContextPacks(file, scope))
          .catch((reason: unknown) => {
            setApplyError(
              reason instanceof Error ? reason.message : String(reason),
            );
            setOpen(true);
          });
      }
    }

    importScopeRef.current = null;
    event.target.value = "";
  };
  const openImportPicker = useCallback(
    (scope?: SmartContextPackScope): void => {
      importScopeRef.current =
        scope ??
        (workspaceRoot && scopeFilter !== "global" ? "workspace" : "global");
      importInputRef.current?.click();
    },
    [scopeFilter, workspaceRoot],
  );
  const contextPackCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "chat.context-pack.apply",
        title: "Apply context pack",
        group: "Chat",
        keywords: ["preset", "setup"],
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        availability: () =>
          sortedPacks.length === 0
            ? { state: "disabled", reason: "No context packs" }
            : applyingPackId
              ? { state: "disabled", reason: "A context pack is being applied" }
              : { state: "enabled" },
        children: () => ({
          id: "chat-context-pack-apply",
          title: "Apply context pack",
          searchPlaceholder: "Choose context pack",
          groups: [
            {
              id: "packs",
              items: packItems.map(({ pack, scope, isMatched }) => ({
                id: pack.id,
                title: pack.name,
                keywords: [
                  formatScopeFilterLabel(scope),
                  pack.prompt,
                  ...(isMatched ? ["matched"] : []),
                ],
                execute: () => applyPack(pack),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.context-pack.create",
        title: "Save current setup as context pack",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        execute: () => openCreateDialog(),
      },
      {
        id: "chat.context-pack.edit",
        title: "Edit context pack",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          sortedPacks.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context packs" },
        children: () => ({
          id: "chat-context-pack-edit",
          title: "Edit context pack",
          searchPlaceholder: "Choose context pack",
          groups: [
            {
              id: "packs",
              items: sortedPacks.map((pack) => ({
                id: pack.id,
                title: pack.name,
                execute: () => openEditDialog(pack),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.context-pack.delete",
        title: "Delete context pack",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          sortedPacks.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context packs" },
        children: () => ({
          id: "chat-context-pack-delete",
          title: "Delete context pack",
          searchPlaceholder: "Choose context pack",
          groups: [
            {
              id: "packs",
              items: sortedPacks.map((pack) => ({
                id: pack.id,
                title: pack.name,
                execute: async () => requestDeletePack(pack),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.context-pack.import",
        title: "Import context packs",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        children: () => ({
          id: "chat-context-pack-import",
          title: "Import context packs",
          searchPlaceholder: "Choose scope",
          numericSelection: true,
          groups: [
            {
              id: "scope",
              items: (workspaceRoot
                ? (["workspace", "global"] as const)
                : (["global"] as const)
              ).map(
                (scope, index): CommandPageItem => ({
                  id: scope,
                  title: formatScopeFilterLabel(scope),
                  numericKey: String(
                    index + 1,
                  ) as CommandPageItem["numericKey"],
                  execute: () => openImportPicker(scope),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "chat.context-pack.export",
        title: "Export context packs",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          sortedPacks.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context packs" },
        children: () => ({
          id: "chat-context-pack-export",
          title: "Export context packs",
          searchPlaceholder: "Choose scope",
          numericSelection: true,
          groups: [
            {
              id: "scope",
              items: (["all", "workspace", "global"] as const).map(
                (scope, index): CommandPageItem => ({
                  id: scope,
                  title: formatScopeFilterLabel(scope),
                  numericKey: String(
                    index + 1,
                  ) as CommandPageItem["numericKey"],
                  availability:
                    scope === "workspace" && !workspaceRoot
                      ? { state: "disabled", reason: "No workspace selected" }
                      : packItems.some(
                            (item) => scope === "all" || item.scope === scope,
                          )
                        ? { state: "enabled" }
                        : { state: "disabled", reason: "No matching packs" },
                  execute: () => onExportContextPacks(scope),
                }),
              ),
            },
          ],
        }),
      },
    ],
    [
      applyingPackId,
      applyPack,
      onExportContextPacks,
      openImportPicker,
      openCreateDialog,
      openEditDialog,
      packItems,
      requestDeletePack,
      sortedPacks,
      workspaceRoot,
    ],
  );
  useOptionalRegisterCommands(contextPackCommands);
  const triggerLabel = contextPacks.length
    ? `Context packs: ${contextPacks.length}`
    : "Context packs";

  return (
    <>
      <input
        ref={importInputRef}
        type="file"
        aria-label="Context pack import file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFileChange}
      />
      <Popover open={open} onOpenChange={handlePopoverOpenChange}>
        <ControlTooltip content={triggerLabel}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              tooltip={null}
              aria-label={triggerLabel}
              disabled={disabled}
              className="app-context-pack-trigger app-composer-toolbar-icon-button app-composer-toolbar-control h-8 w-8 rounded-full p-0 shadow-none"
            >
              <ContextPacksIcon className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </ControlTooltip>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border-slate-800 bg-slate-950/98 p-0 shadow-xl shadow-slate-950/40 backdrop-blur-xl"
          onFocusOutside={(event) => {
            if (view === "configure" || pendingDeletePackId !== null) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            packSearchInputRef.current?.focus();
          }}
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
                <p className="mt-1 text-[11px] text-slate-500">
                  {globalPackCount} global / {workspacePackCount} workspace
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Import context packs"
                  tooltip={`Import ${formatScopeFilterLabel(
                    workspaceRoot && scopeFilter !== "global"
                      ? "workspace"
                      : "global",
                  ).toLowerCase()} context packs`}
                  onClick={() => openImportPicker()}
                  className="h-8 w-8 rounded-full border-slate-800 bg-slate-900/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"
                >
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Export context packs"
                  tooltip={`Export ${formatScopeFilterLabel(
                    scopeFilter,
                  ).toLowerCase()} context packs`}
                  disabled={scopedPackItems.length === 0}
                  onClick={() => onExportContextPacks(scopeFilter)}
                  className="h-8 w-8 rounded-full border-slate-800 bg-slate-900/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:text-slate-600"
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openCreateDialog}
                  className="h-8 rounded-full border-sky-500/20 bg-sky-500/10 px-3 text-xs text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Save
                </Button>
              </div>
            </div>
            <div className="mt-3 flex rounded-full border border-slate-800 bg-slate-900/55 p-0.5">
              {(["all", "workspace", "global"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setScopeFilter(scope)}
                  className={cn(
                    "h-7 flex-1 rounded-full px-2 text-xs font-medium transition-colors",
                    scopeFilter === scope
                      ? "bg-slate-100 text-slate-950"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                  )}
                >
                  {formatScopeFilterLabel(scope)}
                </button>
              ))}
            </div>
            {view === "apply" ? (
              <SearchField
                ref={packSearchInputRef}
                value={packSearchText}
                onChange={(event) => setPackSearchText(event.target.value)}
                onKeyDown={handlePackSearchKeyDown}
                aria-label="Search context packs"
                placeholder="Search packs"
                autoComplete="off"
                spellCheck={false}
                containerClassName="mt-3"
                className="h-9 rounded-2xl border-slate-800 bg-slate-900/70 pr-3 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-sky-400/50 focus-visible:ring-sky-400/30"
              />
            ) : null}
          </div>

          {view === "apply" ? (
            <div className="grid max-h-[26rem] gap-1.5 overflow-y-auto p-3">
              {scopedPackItems.length === 0 ? (
                <button
                  type="button"
                  onClick={openCreateDialog}
                  className="grid gap-2 rounded-2xl border border-dashed border-slate-800 bg-slate-900/45 px-4 py-5 text-left text-slate-300 hover:border-sky-500/30 hover:bg-sky-500/10 hover:text-sky-100"
                >
                  <span className="text-sm font-semibold">
                    Save current setup
                  </span>
                  <span className="text-xs leading-5 text-slate-500">
                    Create a reusable pack from the current setup.
                  </span>
                </button>
              ) : null}

              {scopedPackItems.length > 0 && visiblePackItems.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No matching context packs"
                  size="compact"
                  role="status"
                  className="rounded-2xl bg-slate-900/60"
                />
              ) : null}

              {visiblePackItems.map((item) => (
                <SmartContextPackCard
                  key={item.pack.id}
                  item={item}
                  applyingPackId={applyingPackId}
                  pendingDeletePackId={pendingDeletePackId}
                  onEditPack={openEditDialog}
                  onApplyPack={applyPack}
                  onDeleteContextPack={requestDeletePack}
                />
              ))}
            </div>
          ) : configuringPack ? (
            <SubmitShortcut asChild>
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
                    {...SUBMIT_SHORTCUT_ACTION_PROPS}
                    className="h-8 rounded-full border-sky-500/20 bg-sky-500/10 px-3 text-xs text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-600"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    Apply pack
                  </Button>
                </div>
              </form>
            </SubmitShortcut>
          ) : null}
        </PopoverContent>
      </Popover>
      {packDialog ? (
        <SmartContextPackEditorDialog
          key={packDialog.key}
          open
          initialValue={packDialog.initialValue}
          modelOptions={modelOptions}
          workspaceRoot={workspaceRoot}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setPackDialog(null);
            }
          }}
          onSubmit={handlePackDialogSubmit}
        />
      ) : null}
    </>
  );
};
