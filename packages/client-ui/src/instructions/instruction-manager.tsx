import {
  FileText,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Tags,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { InstructionEditor } from "./instruction-editor";
import { useInstructionCommands } from "./use-instruction-commands";
import type { InstructionTagRule } from "@machdoch/fleet-protocol/instruction-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  InstructionMutationInput,
  InstructionProfileView,
} from "@machdoch/fleet-protocol/instruction-contract";
import {
  createInstructionAiTask,
  extractInstructionAiBody,
} from "./instruction-ai";
import type {
  InstructionManagementControls,
  InstructionRuntime,
  FileFilter,
  ContentMode,
} from "./types";
import {
  isInstructionFormDirty,
  validateInstructionForm,
  type InstructionFormBaseline,
  type InstructionFormDraft,
} from "./instruction-form";

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
  runtime,
  onDirtyChange,
}: {
  setup: InstructionManagementControls;
  runtime: InstructionRuntime;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element => {
  const dirtyRef = useRef(false);
  const discardOnRefreshRef = useRef(false);
  const loadedProfileRef = useRef<InstructionProfileView | null>(null);
  const [baseline, setBaseline] = useState<InstructionFormBaseline | null>(
    null,
  );
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
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
      (!dirtyRef.current || discardOnRefreshRef.current) &&
      (!selectedFileId || !files.some((file) => file.id === selectedFileId))
    ) {
      setSelectedFileId(files[0]?.id ?? null);
    }
  }, [creating, files, selectedFileId]);

  const selectedFile =
    files.find((file) => file.id === selectedFileId) ??
    (loadedProfileRef.current?.id === selectedFileId
      ? loadedProfileRef.current
      : null);

  const loadProfile = useCallback(
    (profile: InstructionProfileView, revision: number): void => {
      loadedProfileRef.current = profile;
      discardOnRefreshRef.current = false;
      setBaseline({
        id: profile.id,
        name: profile.name,
        description: profile.description ?? "",
        body: profile.body ?? "",
        enabled: profile.enabled,
        global: profile.global,
        tags: [...profile.tags],
        match: profile.match ? structuredClone(profile.match) : null,
      });
      setEditingRevision(revision);
      setName(profile.name);
      setDescription(profile.description ?? "");
      setBody(profile.body ?? "");
      setEnabled(profile.enabled);
      setGlobal(profile.global);
      setTags([...profile.tags]);
      setTagDraftPending(false);
      setMatch(profile.match ? structuredClone(profile.match) : null);
      setAiRequest("");
      setAiError(null);
    },
    [],
  );

  const draft: InstructionFormDraft = useMemo(
    () => ({ name, description, body, enabled, global, tags, match }),
    [body, description, enabled, global, match, name, tags],
  );
  const dirty =
    tagDraftPending ||
    isInstructionFormDirty(creating ? null : baseline, draft);

  dirtyRef.current = dirty;
  useEffect(() => {
    if (!selectedFile || creating || !registry) return;
    if (
      dirty &&
      baseline?.id === selectedFile.id &&
      !discardOnRefreshRef.current
    )
      return;
    loadProfile(selectedFile, registry.revision);
  }, [
    selectedFile,
    registry?.revision,
    creating,
    dirty,
    baseline?.id,
    loadProfile,
  ]);

  useEffect(() => {
    onDirtyChange?.(dirty || aiBusy);
  }, [aiBusy, dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(
    () => () => {
      const taskId = aiTaskIdRef.current;
      if (taskId)
        void runtime
          .cancelAiTask(taskId)
          .catch((error: unknown) =>
            console.error("Instruction assistance cancellation failed", error),
          );
    },
    [runtime],
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
    setBaseline(null);
    setEditingRevision(registry?.revision ?? null);
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
    if (registry) loadProfile(selectedFile, registry.revision);
  };

  const refresh = (): void => {
    if (setup.saving || aiBusy || !confirmDiscard()) return;
    discardOnRefreshRef.current = true;
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
            expectedRevision: editingRevision ?? registry.revision,
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
            expectedRevision: editingRevision ?? registry.revision,
          },
    );
    if (ok !== false) {
      const savedId = ok?.profile?.id ?? selectedFile?.id;
      if (savedId) setBaseline({ id: savedId, ...draft });
      setEditingRevision(ok?.library?.revision ?? registry.revision);
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
      const response = await runtime.runAiTask(
        setup.workspaceRoot,
        createInstructionAiTask({
          mode: body.trim() ? "improve" : "create",
          name,
          ...(description.trim() ? { description } : {}),
          body,
          ...(aiRequest.trim() ? { request: aiRequest } : {}),
        }),
        taskId,
      );
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
      await runtime.cancelAiTask(taskId);
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

  useInstructionCommands({
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

  return (
    <main className="app-management-view flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-900 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Instructions</h1>
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

      <div className="app-management-panes grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(11rem,30vh)_minmax(0,1fr)] lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-1">
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
            <InstructionEditor
              creating={creating}
              global={global}
              name={name}
              selectedFile={selectedFile}
              match={match}
              tags={tags}
              dirty={dirty}
              formDisabled={formDisabled}
              discardChanges={discardChanges}
              tagDraftPending={tagDraftPending}
              validationError={validationError}
              pendingTagMessageId={pendingTagMessageId}
              saveFile={saveFile}
              registry={registry}
              duplicateFile={duplicateFile}
              deleteFile={deleteFile}
              hasManualAssignments={hasManualAssignments}
              validationErrorId={validationErrorId}
              nameInvalid={nameInvalid}
              setName={setName}
              description={description}
              descriptionInvalid={descriptionInvalid}
              setDescription={setDescription}
              bodyInvalid={bodyInvalid}
              enabled={enabled}
              setEnabled={setEnabled}
              setGlobalMode={setGlobalMode}
              setTagDraftPending={setTagDraftPending}
              setTags={setTags}
              setMatch={setMatch}
              matchInvalid={matchInvalid}
              body={body}
              contentMode={contentMode}
              setContentMode={setContentMode}
              contentViewId={contentViewId}
              aiBusy={aiBusy}
              aiRequest={aiRequest}
              setAiRequest={setAiRequest}
              aiCancelling={aiCancelling}
              cancelAiAssist={cancelAiAssist}
              runAiAssist={runAiAssist}
              aiError={aiError}
              setup={setup}
              runtime={runtime}
              setBody={setBody}
            />
          )}
        </section>
      </div>
    </main>
  );
};
