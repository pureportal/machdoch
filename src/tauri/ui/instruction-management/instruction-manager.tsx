import {
  Copy,
  FileText,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Tags,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import {
  MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH,
  MAX_INSTRUCTION_PROFILE_NAME_LENGTH,
  MAX_INSTRUCTION_SOURCE_BYTES,
} from "../../../core/instruction-system/limits.js";
import type { InstructionTagRule } from "../../../core/instruction-system/types.js";
import { MarkdownContent } from "../components/markdown-content";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { SearchField } from "../components/ui/search-field";
import { Textarea } from "../components/ui/textarea";
import { getDefaultCommandShortcut } from "../commands/command-defaults";
import { useOptionalRegisterCommands } from "../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "../commands/command-types";
import { cn } from "../lib/utils";
import {
  cancelDesktopTask,
  runDesktopTask,
  type InstructionMutationInput,
  type InstructionProfileView,
} from "../runtime";
import {
  createInstructionAiTask,
  extractInstructionAiBody,
} from "./instruction-ai";
import { TagEditor } from "./tag-editor";
import { createEmptyTagGroup, TagRuleEditor } from "./tag-rule-editor";
import type { InstructionManagementControls } from "./types";
import {
  isInstructionFormDirty,
  validateInstructionForm,
  type InstructionFormBaseline,
  type InstructionFormDraft,
} from "./instruction-form";

type FileFilter = "all" | "global" | "tag-match" | "manual" | "disabled";
type ContentMode = "edit" | "preview";

const fileIsEnabled = (file: InstructionProfileView): boolean => file.enabled;

const fileTags = (file: InstructionProfileView): string[] => file.tags;

const fileStatusText = (file: InstructionProfileView): string => {
  if (file.global) return "Global";
  if (!fileIsEnabled(file)) {
    return `${file.match ? "Tag match" : "Manual"} · Disabled`;
  }
  if (file.match) return "Tag match";
  return "Manual";
};

const fileStatusIcon = (file: InstructionProfileView): JSX.Element => {
  if (file.global) return <Globe2 className="size-3.5" aria-hidden="true" />;
  if (file.match) return <Tags className="size-3.5" aria-hidden="true" />;
  return <FileText className="size-3.5" aria-hidden="true" />;
};

export const InstructionManager = ({
  setup,
  onDirtyChange,
}: {
  setup: InstructionManagementControls;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element => {
  const registry = setup.registry;
  const files = registry?.profiles ?? [];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FileFilter>("all");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [global, setGlobal] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraftPending, setTagDraftPending] = useState(false);
  const [match, setMatch] = useState<InstructionTagRule | null>(null);
  const [contentMode, setContentMode] = useState<ContentMode>("edit");
  const [aiRequest, setAiRequest] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiCancelling, setAiCancelling] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiTaskIdRef = useRef<string | null>(null);
  const previousSelectionRef = useRef<string | null>(null);
  const validationErrorId = useId();
  const pendingTagMessageId = useId();
  const contentViewId = useId();

  useEffect(() => {
    void setup.onRefresh();
  }, [setup.onRefresh]);

  useEffect(() => {
    if (
      !creating &&
      (!selectedFileId || !files.some((file) => file.id === selectedFileId))
    ) {
      setSelectedFileId(files[0]?.id ?? null);
    }
  }, [creating, files, selectedFileId]);

  const selectedFile = files.find((file) => file.id === selectedFileId) ?? null;

  useEffect(() => {
    if (!selectedFile) return;
    setName(selectedFile.name);
    setDescription(selectedFile.description ?? "");
    setBody(selectedFile.body ?? "");
    setEnabled(fileIsEnabled(selectedFile));
    setGlobal(selectedFile.global);
    setTags([...fileTags(selectedFile)]);
    setTagDraftPending(false);
    setMatch(selectedFile.match ? structuredClone(selectedFile.match) : null);
    setAiRequest("");
    setAiError(null);
  }, [selectedFile]);

  const draft: InstructionFormDraft = useMemo(
    () => ({ name, description, body, enabled, global, tags, match }),
    [body, description, enabled, global, match, name, tags],
  );
  const baseline: InstructionFormBaseline | null = useMemo(
    () =>
      selectedFile
        ? {
            id: selectedFile.id,
            name: selectedFile.name,
            description: selectedFile.description ?? "",
            body: selectedFile.body ?? "",
            enabled: fileIsEnabled(selectedFile),
            global: selectedFile.global,
            tags: [...fileTags(selectedFile)],
            match: selectedFile.match
              ? structuredClone(selectedFile.match)
              : null,
          }
        : null,
    [selectedFile],
  );
  const dirty =
    tagDraftPending ||
    isInstructionFormDirty(creating ? null : baseline, draft);

  useEffect(() => {
    onDirtyChange?.(dirty || aiBusy);
  }, [aiBusy, dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(
    () => () => {
      const taskId = aiTaskIdRef.current;
      if (taskId) void cancelDesktopTask(taskId).catch(() => undefined);
    },
    [],
  );

  const validationError = validateInstructionForm(draft);
  const nameInvalid = Boolean(
    dirty &&
    (validationError === "Enter a name." ||
      validationError?.startsWith("Name ")),
  );
  const descriptionInvalid = Boolean(
    dirty && validationError?.startsWith("Description "),
  );
  const bodyInvalid = Boolean(
    dirty &&
    (validationError?.startsWith("Instruction content") ||
      validationError?.startsWith("Enter instruction")),
  );
  const matchInvalid = Boolean(
    dirty &&
    match !== null &&
    validationError &&
    !nameInvalid &&
    !descriptionInvalid &&
    !bodyInvalid,
  );

  const mutate = async (input: InstructionMutationInput) =>
    await setup.onSave(input);

  const confirmDiscard = (): boolean =>
    !dirty || window.confirm("Discard unsaved instruction changes?");

  const startFile = (): void => {
    if (setup.saving || aiBusy || !confirmDiscard()) return;
    previousSelectionRef.current = selectedFileId;
    setCreating(true);
    setSelectedFileId(null);
    setName("");
    setDescription("");
    setBody("");
    setEnabled(true);
    setGlobal(false);
    setTags([]);
    setTagDraftPending(false);
    setMatch(null);
    setContentMode("edit");
    setAiRequest("");
    setAiError(null);
  };

  const selectFile = (fileId: string): void => {
    if (
      setup.saving ||
      aiBusy ||
      (!creating && selectedFileId === fileId) ||
      !confirmDiscard()
    )
      return;
    setCreating(false);
    setSelectedFileId(fileId);
    setTagDraftPending(false);
  };

  const cancelCreate = (): void => {
    if (!confirmDiscard()) return;
    const previous = previousSelectionRef.current;
    setCreating(false);
    setTagDraftPending(false);
    setSelectedFileId(
      previous && files.some((file) => file.id === previous)
        ? previous
        : (files[0]?.id ?? null),
    );
  };

  const discardChanges = (): void => {
    if (creating) {
      cancelCreate();
      return;
    }
    if (!selectedFile || !confirmDiscard()) return;
    setName(selectedFile.name);
    setDescription(selectedFile.description ?? "");
    setBody(selectedFile.body ?? "");
    setEnabled(fileIsEnabled(selectedFile));
    setGlobal(selectedFile.global);
    setTags([...fileTags(selectedFile)]);
    setTagDraftPending(false);
    setMatch(selectedFile.match ? structuredClone(selectedFile.match) : null);
    setAiRequest("");
    setAiError(null);
  };

  const refresh = (): void => {
    if (setup.saving || aiBusy || !confirmDiscard()) return;
    void setup.onRefresh();
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredFiles = useMemo(
    () =>
      files.filter((file) => {
        const matchesFilter =
          filter === "all" ||
          (filter === "global" && file.global) ||
          (filter === "tag-match" && file.match !== undefined) ||
          (filter === "manual" && !file.global && file.match === undefined) ||
          (filter === "disabled" && !fileIsEnabled(file));
        if (!matchesFilter) return false;
        return (
          !normalizedQuery ||
          [file.name, file.description ?? "", ...fileTags(file)]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery)
        );
      }),
    [files, filter, normalizedQuery],
  );

  const saveFile = async (): Promise<void> => {
    if (
      !registry ||
      setup.saving ||
      aiBusy ||
      registry.libraryError ||
      registry.recovery?.primaryValid === false ||
      tagDraftPending ||
      validationError ||
      !dirty
    )
      return;
    const fileEnabled = global ? true : enabled;
    const ok = await mutate(
      selectedFile
        ? {
            operation: "profile-edit",
            profileId: selectedFile.id,
            name,
            description,
            body,
            enabled: fileEnabled,
            global,
            tags,
            match: global ? null : match,
            expectedRevision: registry.revision,
          }
        : {
            operation: "profile-create",
            name,
            description,
            body,
            enabled: fileEnabled,
            global,
            tags,
            ...(global || match === null ? {} : { match }),
            expectedRevision: registry.revision,
          },
    );
    if (ok !== false) {
      setCreating(false);
      setSelectedFileId(ok?.profile?.id ?? selectedFile?.id ?? null);
    }
  };

  const runAiAssist = async (): Promise<void> => {
    if (setup.saving || aiBusy || !name.trim() || !setup.workspaceRoot) return;
    const taskId = crypto.randomUUID();
    aiTaskIdRef.current = taskId;
    setAiBusy(true);
    setAiCancelling(false);
    setAiError(null);
    try {
      const result = await runDesktopTask(
        setup.workspaceRoot,
        createInstructionAiTask({
          mode: body.trim() ? "improve" : "create",
          name,
          ...(description.trim() ? { description } : {}),
          body,
          ...(aiRequest.trim() ? { request: aiRequest } : {}),
        }),
        { mode: "ask", taskId },
      );
      const response =
        result.execution.response?.markdown ?? result.execution.summary;
      const nextBody = extractInstructionAiBody(response);
      if (!nextBody) {
        throw new Error("AI assistance did not return an instruction file.");
      }
      setBody(nextBody);
      setAiRequest("");
      setContentMode("edit");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      if (aiTaskIdRef.current === taskId) aiTaskIdRef.current = null;
      setAiBusy(false);
      setAiCancelling(false);
    }
  };

  const cancelAiAssist = async (): Promise<void> => {
    const taskId = aiTaskIdRef.current;
    if (!taskId || aiCancelling) return;
    setAiCancelling(true);
    try {
      await cancelDesktopTask(taskId);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
      setAiCancelling(false);
    }
  };

  const editing = creating || selectedFile !== null;
  const recovery = registry?.recovery;
  const hasManualAssignments = Boolean(selectedFile?.manualAssignmentCount);
  const busy = setup.saving || aiBusy;
  const libraryUnavailable = Boolean(
    !registry || registry.libraryError || recovery?.primaryValid === false,
  );
  const formDisabled = setup.loading || busy || libraryUnavailable;

  const duplicateFile = async (): Promise<void> => {
    if (
      !registry ||
      !selectedFile ||
      dirty ||
      setup.saving ||
      aiBusy ||
      libraryUnavailable
    )
      return;
    const result = await mutate({
      operation: "profile-duplicate",
      profileId: selectedFile.id,
      expectedRevision: registry.revision,
    });
    if (result !== false && result?.profile?.id) {
      setSelectedFileId(result.profile.id);
    }
  };

  const deleteFile = async (): Promise<void> => {
    if (
      !registry ||
      !selectedFile ||
      dirty ||
      setup.saving ||
      aiBusy ||
      libraryUnavailable ||
      hasManualAssignments
    )
      return;
    if (
      !window.confirm(`Delete "${selectedFile.name}"? This cannot be undone.`)
    )
      return;
    const deletedId = selectedFile.id;
    const result = await mutate({
      operation: "profile-delete",
      profileId: deletedId,
      expectedRevision: registry.revision,
    });
    if (result !== false) {
      setSelectedFileId(null);
    }
  };

  const restoreRecovery = (): void => {
    if (!recovery?.backupValid || !recovery.backupDigest || busy) return;
    void mutate({
      operation: "recovery-restore",
      expectedDigest: recovery.backupDigest,
    });
  };

  const resetRecovery = (): void => {
    if (!recovery?.resetDigest || busy) return;
    if (
      !window.confirm(
        "Preserve the corrupt file and create an empty instruction library?",
      )
    )
      return;
    void mutate({
      operation: "recovery-reset",
      expectedDigest: recovery.resetDigest,
    });
  };

  const setGlobalMode = (nextGlobal: boolean): void => {
    if (formDisabled || hasManualAssignments) return;
    setGlobal(nextGlobal);
    if (nextGlobal) {
      setEnabled(true);
      setMatch(null);
    }
  };

  const instructionCommandStateRef = useRef({
    files,
    filteredFiles,
    selectedFileId,
    selectedFile,
    filter,
    contentMode,
    creating,
    dirty,
    enabled,
    global,
    match,
    name,
    body,
    aiBusy,
    aiCancelling,
    formDisabled,
    hasManualAssignments,
    validationError,
    tagDraftPending,
    libraryUnavailable,
    setup,
    recovery,
    startFile,
    selectFile,
    refresh,
    saveFile,
    discardChanges,
    duplicateFile,
    deleteFile,
    restoreRecovery,
    resetRecovery,
    setFilter,
    setContentMode,
    setEnabled,
    setGlobalMode,
    setMatch,
    runAiAssist,
    cancelAiAssist,
  });
  instructionCommandStateRef.current = {
    files,
    filteredFiles,
    selectedFileId,
    selectedFile,
    filter,
    contentMode,
    creating,
    dirty,
    enabled,
    global,
    match,
    name,
    body,
    aiBusy,
    aiCancelling,
    formDisabled,
    hasManualAssignments,
    validationError,
    tagDraftPending,
    libraryUnavailable,
    setup,
    recovery,
    startFile,
    selectFile,
    refresh,
    saveFile,
    discardChanges,
    duplicateFile,
    deleteFile,
    restoreRecovery,
    resetRecovery,
    setFilter,
    setContentMode,
    setEnabled,
    setGlobalMode,
    setMatch,
    runAiAssist,
    cancelAiAssist,
  };

  const instructionCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = {
      kind: "view" as const,
      ownerId: "instructions",
      viewId: "instructions",
    };
    const state = () => instructionCommandStateRef.current;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    return asPaletteCommands([
      {
        id: "instructions.file.new",
        title: "New instruction file",
        group: "Instructions",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("instructions.file.new"),
            runtimes: ["tauri"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () =>
          state().formDisabled
            ? { state: "disabled", reason: "Instruction library is busy." }
            : { state: "enabled" },
        overlayPolicy: "replace-non-modal",
        execute: () => state().startFile(),
      },
      {
        id: "instructions.file.open",
        title: "Open instruction file",
        group: "Instructions",
        scope,
        availability: () =>
          state().files.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No instruction files." },
        children: () => ({
          id: "instructions.file.open.page",
          title: "Open instruction file",
          searchPlaceholder: "Search instruction files",
          numericSelection: true,
          groups: [
            {
              id: "files",
              items: state().files.map((file, index) => ({
                id: file.id,
                title: file.name,
                keywords: [file.description ?? "", ...file.tags],
                current: state().selectedFileId === file.id,
                numericKey: numericKey(index),
                availability:
                  state().setup.saving || state().aiBusy
                    ? { state: "disabled", reason: "Instructions are busy." }
                    : { state: "enabled" },
                execute: () => state().selectFile(file.id),
              })),
            },
          ],
        }),
      },
      {
        id: "instructions.refresh",
        title: "Refresh instructions",
        group: "Instructions",
        scope,
        availability: () =>
          state().setup.loading || state().setup.saving || state().aiBusy
            ? { state: "disabled", reason: "Instructions are busy." }
            : { state: "enabled" },
        execute: () => state().refresh(),
      },
      {
        id: "instructions.file.save",
        title: "Save instruction file",
        group: "Instructions",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("instructions.file.save"),
            runtimes: ["tauri"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () => {
          const current = state();
          if (!current.selectedFile && !current.creating)
            return { state: "hidden" };
          if (current.formDisabled)
            return {
              state: "disabled",
              reason: "Instruction library is unavailable.",
            };
          if (current.tagDraftPending)
            return {
              state: "disabled",
              reason: "Finish editing the pending tag.",
            };
          if (current.validationError)
            return { state: "disabled", reason: current.validationError };
          if (!current.dirty)
            return { state: "disabled", reason: "No changes to save." };
          return { state: "enabled" };
        },
        execute: () => void state().saveFile(),
      },
      {
        id: "instructions.file.discard",
        title: "Discard instruction changes",
        group: "Instructions",
        scope,
        availability: () =>
          state().creating || state().dirty
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().discardChanges(),
      },
      {
        id: "instructions.file.duplicate",
        title: "Duplicate instruction file",
        group: "Instructions",
        scope,
        availability: () => {
          const current = state();
          if (!current.selectedFile) return { state: "hidden" };
          return current.formDisabled || current.dirty
            ? { state: "disabled", reason: "Save or discard changes first." }
            : { state: "enabled" };
        },
        execute: () => void state().duplicateFile(),
      },
      {
        id: "instructions.file.delete",
        title: "Delete instruction file",
        group: "Instructions",
        scope,
        availability: () => {
          const current = state();
          if (!current.selectedFile) return { state: "hidden" };
          if (current.hasManualAssignments)
            return {
              state: "disabled",
              reason: "Remove workspace assignments first.",
            };
          return current.formDisabled || current.dirty
            ? { state: "disabled", reason: "Save or discard changes first." }
            : { state: "enabled" };
        },
        execute: () => void state().deleteFile(),
      },
      {
        id: "instructions.filter.select",
        title: "Filter instruction files",
        group: "Instructions",
        scope,
        children: () => ({
          id: "instructions.filter.select.page",
          title: "Filter instruction files",
          searchPlaceholder: "Search filters",
          numericSelection: true,
          groups: [
            {
              id: "filters",
              items: (
                ["all", "global", "tag-match", "manual", "disabled"] as const
              ).map((value, index) => ({
                id: value,
                title:
                  value === "tag-match"
                    ? "Tag match"
                    : `${value[0]?.toUpperCase()}${value.slice(1)}`,
                current: state().filter === value,
                numericKey: numericKey(index),
                execute: () => state().setFilter(value),
              })),
            },
          ],
        }),
      },
      {
        id: "instructions.content.mode",
        title: "Choose content view",
        group: "Instructions",
        scope,
        availability: () =>
          state().selectedFile || state().creating
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "instructions.content.mode.page",
          title: "Choose content view",
          searchPlaceholder: "Search views",
          numericSelection: true,
          groups: [
            {
              id: "views",
              items: (["edit", "preview"] as const).map((mode, index) => ({
                id: mode,
                title: mode === "edit" ? "Edit" : "Preview",
                current: state().contentMode === mode,
                numericKey: numericKey(index),
                execute: () => state().setContentMode(mode),
              })),
            },
          ],
        }),
      },
      {
        id: "instructions.file.toggle-enabled",
        title: "Toggle instruction file",
        group: "Instructions",
        scope,
        availability: () =>
          !state().selectedFile && !state().creating
            ? { state: "hidden" }
            : state().formDisabled || state().global
              ? {
                  state: "disabled",
                  reason: "Global files are always enabled.",
                }
              : { state: "enabled" },
        current: () => state().global || state().enabled,
        execute: () => state().setEnabled(!state().enabled),
      },
      {
        id: "instructions.file.toggle-global",
        title: "Toggle global instruction file",
        group: "Instructions",
        scope,
        availability: () =>
          !state().selectedFile && !state().creating
            ? { state: "hidden" }
            : state().formDisabled || state().hasManualAssignments
              ? {
                  state: "disabled",
                  reason: "Remove workspace assignments first.",
                }
              : { state: "enabled" },
        current: () => state().global,
        execute: () => state().setGlobalMode(!state().global),
      },
      {
        id: "instructions.file.toggle-tag-match",
        title: "Toggle workspace tag match",
        group: "Instructions",
        scope,
        availability: () =>
          !state().selectedFile && !state().creating
            ? { state: "hidden" }
            : state().formDisabled ||
                state().global ||
                state().hasManualAssignments
              ? {
                  state: "disabled",
                  reason: "Assignment mode cannot be changed.",
                }
              : { state: "enabled" },
        current: () => state().match !== null,
        execute: () =>
          state().setMatch(state().match ? null : createEmptyTagGroup()),
      },
      {
        id: "instructions.ai.run",
        title: "Create or improve with AI",
        group: "Instructions",
        scope,
        availability: () => {
          const current = state();
          if (!current.selectedFile && !current.creating)
            return { state: "hidden" };
          if (!current.setup.workspaceRoot)
            return { state: "disabled", reason: "Select a workspace first." };
          if (!current.name.trim())
            return { state: "disabled", reason: "Enter a file name first." };
          if (current.formDisabled)
            return {
              state: "disabled",
              reason: "Instruction file is unavailable.",
            };
          return current.aiBusy || current.aiCancelling
            ? { state: "disabled", reason: "AI editing is already running." }
            : { state: "enabled" };
        },
        execute: () => void state().runAiAssist(),
      },
      {
        id: "instructions.ai.cancel",
        title: "Cancel AI editing",
        group: "Instructions",
        scope,
        availability: () =>
          state().aiBusy
            ? state().aiCancelling
              ? { state: "disabled", reason: "Cancellation is in progress." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => void state().cancelAiAssist(),
      },
      {
        id: "instructions.recovery.restore",
        title: "Restore instruction library backup",
        group: "Instructions",
        scope,
        availability: () =>
          state().recovery?.backupValid && state().recovery?.backupDigest
            ? state().setup.saving || state().aiBusy
              ? { state: "disabled", reason: "Instructions are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().restoreRecovery(),
      },
      {
        id: "instructions.recovery.reset",
        title: "Reset instruction library",
        group: "Instructions",
        scope,
        availability: () =>
          state().recovery?.resetDigest
            ? state().setup.saving || state().aiBusy
              ? { state: "disabled", reason: "Instructions are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().resetRecovery(),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(instructionCommands);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-900 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Instructions</h1>
          <p className="mt-1 text-xs text-slate-500">
            {files.length} {files.length === 1 ? "file" : "files"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={formDisabled}
            onClick={startFile}
          >
            <Plus className="size-4" />
            New file
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={setup.loading || busy}
            aria-label="Refresh instructions"
            onClick={refresh}
          >
            <RefreshCw
              className={cn("size-4", setup.loading && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {setup.message ? (
        <div
          role={setup.message.tone === "error" ? "alert" : "status"}
          className={cn(
            "shrink-0 border-b px-6 py-2 text-sm",
            setup.message.tone === "error"
              ? "border-red-950 bg-red-950/30 text-red-200"
              : "border-slate-900 bg-slate-900/35 text-slate-300",
          )}
        >
          {setup.message.text}
        </div>
      ) : null}

      {recovery?.errorCode ===
      "INSTRUCTION_LIBRARY_RECOVERY_STATUS_UNAVAILABLE" ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-900/60 bg-amber-950/20 px-6 py-3 text-sm text-amber-200"
        >
          <span className="min-w-0 flex-1">
            {recovery.errorMessage ?? "Recovery status could not be loaded."}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={setup.loading || busy}
            onClick={refresh}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {registry?.libraryError && recovery?.primaryValid !== false ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-red-900/60 bg-red-950/25 px-6 py-3 text-sm text-red-200"
        >
          <span className="min-w-0 flex-1">{registry.libraryError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={setup.loading || busy}
            onClick={refresh}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {recovery && !recovery.primaryValid ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-red-900/60 bg-red-950/25 px-6 py-3 text-sm text-red-200"
        >
          <span className="min-w-0 flex-1">
            {recovery.errorMessage ?? "Instruction library unavailable."}
          </span>
          {recovery.backupValid && recovery.backupDigest ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={restoreRecovery}
            >
              Restore
            </Button>
          ) : null}
          {recovery.resetDigest ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={resetRecovery}
            >
              Reset
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(11rem,30vh)_minmax(0,1fr)] lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-1">
        <aside className="flex min-h-0 min-w-0 flex-col border-r border-slate-900 bg-slate-950/70">
          <div className="shrink-0 space-y-3 border-b border-slate-900 p-4">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search instruction files"
              placeholder="Search files"
              className="h-9 border-slate-800 bg-slate-950"
            />
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label="File filter"
            >
              {(
                ["all", "global", "tag-match", "manual", "disabled"] as const
              ).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
                    filter === value
                      ? "bg-sky-500/15 text-sky-200"
                      : "text-slate-500 hover:bg-slate-900 hover:text-slate-200",
                  )}
                >
                  {value === "tag-match"
                    ? "Tag match"
                    : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {setup.loading && !registry ? (
              <div className="grid h-32 place-items-center text-slate-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
            ) : libraryUnavailable ? null : filteredFiles.length === 0 ? (
              <EmptyState
                icon={Search}
                title={
                  files.length === 0
                    ? "No instruction files"
                    : "No matching files"
                }
                size="compact"
              />
            ) : (
              <div className="space-y-1">
                {filteredFiles.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    aria-pressed={selectedFileId === file.id}
                    onClick={() => selectFile(file.id)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
                      selectedFileId === file.id
                        ? "border-sky-800/70 bg-sky-950/25"
                        : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
                      !fileIsEnabled(file) && "opacity-60",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 text-slate-500" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
                        {file.name}
                      </span>
                    </div>
                    <div className="mt-1.5 flex min-w-0 items-center gap-1.5 pl-6 text-[11px] text-slate-500">
                      {fileStatusIcon(file)}
                      <span>{fileStatusText(file)}</span>
                      {file.description ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{file.description}</span>
                        </>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-0 min-w-0 overflow-y-auto">
          {!editing ? (
            <div className="grid h-full min-h-64 place-items-center p-6">
              {setup.loading && !registry ? (
                <LoaderCircle className="size-5 animate-spin text-slate-500" />
              ) : (
                <EmptyState
                  icon={FileText}
                  title={
                    libraryUnavailable
                      ? "Instruction library unavailable"
                      : "Select an instruction file"
                  }
                  action={
                    libraryUnavailable ? undefined : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={formDisabled}
                        onClick={startFile}
                      >
                        <Plus className="size-4" />
                        New file
                      </Button>
                    )
                  }
                />
              )}
            </div>
          ) : (
            <div className="mx-auto w-full max-w-7xl space-y-5 p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {global ? (
                      <Globe2 className="size-5 text-sky-300" />
                    ) : (
                      <FileText className="size-5 text-sky-300" />
                    )}
                    <h2 className="truncate text-base font-semibold text-slate-100">
                      {creating
                        ? "New instruction file"
                        : name.trim() || selectedFile?.name}
                    </h2>
                  </div>
                  {!creating ? (
                    <p className="mt-1.5 text-xs text-slate-500">
                      {global
                        ? "Global"
                        : match
                          ? "Assigned by workspace tags"
                          : "Assigned manually"}
                      {tags.length > 0 ? ` · ${tags.length} tags` : ""}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {creating || dirty ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={formDisabled}
                      onClick={discardChanges}
                    >
                      {creating ? "Cancel" : "Discard"}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      formDisabled ||
                      tagDraftPending ||
                      !dirty ||
                      validationError !== null
                    }
                    aria-describedby={
                      tagDraftPending ? pendingTagMessageId : undefined
                    }
                    onClick={() => void saveFile()}
                  >
                    <Save className="size-4" />
                    Save
                  </Button>
                  {selectedFile && registry ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      disabled={formDisabled || dirty}
                      aria-label="Duplicate instruction file"
                      title={
                        dirty ? "Save or discard changes first." : undefined
                      }
                      onClick={() => void duplicateFile()}
                    >
                      <Copy className="size-4" />
                    </Button>
                  ) : null}
                  {selectedFile && registry ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={formDisabled || dirty || hasManualAssignments}
                      aria-label="Delete instruction file"
                      title={
                        dirty
                          ? "Save or discard changes first."
                          : selectedFile.manualAssignmentCount
                            ? "Remove workspace assignments first."
                            : undefined
                      }
                      onClick={() => void deleteFile()}
                    >
                      <Trash2 className="size-4 text-red-300" />
                    </Button>
                  ) : null}
                </div>
              </div>

              {dirty && validationError ? (
                <p
                  id={validationErrorId}
                  role="alert"
                  className="text-sm text-red-300"
                >
                  {validationError}
                </p>
              ) : null}

              <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                    Name
                    <Input
                      value={name}
                      maxLength={MAX_INSTRUCTION_PROFILE_NAME_LENGTH * 2}
                      disabled={formDisabled}
                      aria-invalid={nameInvalid}
                      aria-describedby={
                        nameInvalid ? validationErrorId : undefined
                      }
                      onChange={(event) => setName(event.target.value)}
                      className="h-9 border-slate-800 bg-slate-950"
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                    Description
                    <Input
                      value={description}
                      maxLength={MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH * 2}
                      disabled={formDisabled}
                      aria-invalid={descriptionInvalid}
                      aria-describedby={
                        descriptionInvalid ? validationErrorId : undefined
                      }
                      onChange={(event) => setDescription(event.target.value)}
                      className="h-9 border-slate-800 bg-slate-950"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-5">
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={global || enabled}
                      disabled={formDisabled || global}
                      onChange={(event) => setEnabled(event.target.checked)}
                      className="accent-sky-500"
                    />
                    Enabled
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={global}
                      disabled={formDisabled || hasManualAssignments}
                      onChange={(event) => setGlobalMode(event.target.checked)}
                      className="accent-sky-500"
                    />
                    Global
                  </label>
                </div>
                <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                  Tags
                  <TagEditor
                    value={tags}
                    disabled={formDisabled}
                    onChange={setTags}
                    onPendingChange={setTagDraftPending}
                  />
                </label>
                {hasManualAssignments ? (
                  <p className="text-xs text-slate-500">
                    Remove manual workspace assignments before changing the
                    assignment mode or deleting this file.
                  </p>
                ) : null}
                {tagDraftPending ? (
                  <p
                    id={pendingTagMessageId}
                    className="text-xs text-slate-500"
                  >
                    Add or clear the pending tag before saving.
                  </p>
                ) : null}
              </section>

              {!global ? (
                <section className="rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-slate-200">
                      Workspace tag match
                    </h3>
                    <label className="flex items-center gap-2 text-sm text-slate-400">
                      <input
                        type="checkbox"
                        checked={match !== null}
                        disabled={formDisabled || hasManualAssignments}
                        onChange={(event) =>
                          setMatch(
                            event.target.checked ? createEmptyTagGroup() : null,
                          )
                        }
                        className="accent-sky-500"
                      />
                      Enabled
                    </label>
                  </div>
                  {match ? (
                    <TagRuleEditor
                      value={match}
                      disabled={formDisabled}
                      errorId={matchInvalid ? validationErrorId : undefined}
                      onChange={setMatch}
                    />
                  ) : null}
                </section>
              ) : null}

              <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-medium text-slate-200">
                      Content
                    </h3>
                    <div
                      className="inline-flex rounded-md border border-slate-800 bg-slate-950 p-0.5"
                      role="tablist"
                      aria-label="Instruction content view"
                    >
                      {(["edit", "preview"] as const).map((mode) => (
                        <button
                          key={mode}
                          id={`${contentViewId}-tab-${mode}`}
                          type="button"
                          role="tab"
                          tabIndex={contentMode === mode ? 0 : -1}
                          aria-controls={contentViewId}
                          aria-selected={contentMode === mode}
                          onClick={() => setContentMode(mode)}
                          onKeyDown={(event) => {
                            if (
                              ![
                                "ArrowLeft",
                                "ArrowRight",
                                "Home",
                                "End",
                              ].includes(event.key)
                            )
                              return;
                            event.preventDefault();
                            const nextMode =
                              event.key === "Home"
                                ? "edit"
                                : event.key === "End"
                                  ? "preview"
                                  : contentMode === "edit"
                                    ? "preview"
                                    : "edit";
                            setContentMode(nextMode);
                            document
                              .getElementById(
                                `${contentViewId}-tab-${nextMode}`,
                              )
                              ?.focus();
                          }}
                          className={cn(
                            "rounded px-2.5 py-1 text-xs capitalize outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
                            contentMode === mode
                              ? "bg-slate-800 text-slate-100"
                              : "text-slate-500 hover:text-slate-200",
                          )}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:max-w-xl">
                    <Input
                      value={aiRequest}
                      disabled={formDisabled}
                      aria-label="AI editing request"
                      placeholder={
                        body.trim()
                          ? "Editing request"
                          : "What should it cover?"
                      }
                      onChange={(event) => setAiRequest(event.target.value)}
                      className="h-8 min-w-28 flex-1 border-slate-800 bg-slate-950"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        setup.saving ||
                        aiCancelling ||
                        (!aiBusy &&
                          (formDisabled ||
                            !name.trim() ||
                            !setup.workspaceRoot))
                      }
                      title={
                        !setup.workspaceRoot && !aiBusy
                          ? "Select a workspace to use AI editing."
                          : undefined
                      }
                      onClick={() =>
                        void (aiBusy ? cancelAiAssist() : runAiAssist())
                      }
                    >
                      {aiBusy ? (
                        aiCancelling ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <X className="size-4" />
                        )
                      ) : body.trim() ? (
                        <WandSparkles className="size-4" />
                      ) : (
                        <Sparkles className="size-4" />
                      )}
                      {aiBusy
                        ? aiCancelling
                          ? "Canceling"
                          : "Cancel"
                        : body.trim()
                          ? "Improve"
                          : "Create"}
                    </Button>
                  </div>
                </div>
                {aiError ? (
                  <p
                    role="alert"
                    className="border-b border-red-950 bg-red-950/20 px-4 py-2 text-sm text-red-300"
                  >
                    {aiError}
                  </p>
                ) : null}
                <div
                  id={contentViewId}
                  role="tabpanel"
                  aria-labelledby={`${contentViewId}-tab-${contentMode}`}
                  className="min-h-[34rem]"
                >
                  {contentMode === "edit" ? (
                    <Textarea
                      value={body}
                      maxLength={MAX_INSTRUCTION_SOURCE_BYTES}
                      disabled={formDisabled}
                      aria-label="Instruction Markdown"
                      aria-invalid={bodyInvalid}
                      aria-describedby={
                        bodyInvalid ? validationErrorId : undefined
                      }
                      onChange={(event) => setBody(event.target.value)}
                      spellCheck={false}
                      className="min-h-[34rem] resize-y rounded-none border-0 bg-slate-950/70 p-5 font-mono text-sm leading-6 text-slate-100 focus-visible:ring-0"
                    />
                  ) : body.trim() ? (
                    <article className="mx-auto max-w-4xl px-6 py-7 sm:px-8">
                      <MarkdownContent
                        content={body}
                        className="text-sm text-slate-200"
                      />
                    </article>
                  ) : (
                    <div className="grid min-h-[34rem] place-items-center text-sm text-slate-600">
                      Nothing to preview
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
    </main>
  );
};
