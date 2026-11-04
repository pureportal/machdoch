import { ArrowLeft, CircleAlert, LoaderCircle, Play, Settings2, Sparkles } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  WORKSPACE_RUN_SCHEMA_VERSION,
  createEmptyWorkspaceRunDocument,
  type WorkspaceRunConfigurationDocument,
  type WorkspaceRunConfigurationStatus,
  type WorkspaceRunInputValues,
  type WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { AppNotification } from "@machdoch/media-studio/tauri/ui/components/ui/notification.js";
import {
  listenWorkspaceRunLogs,
  listenWorkspaceRunState,
  loadWorkspaceRunConfigurationDocument,
  loadWorkspaceRunSnapshot,
  openWorkspaceRunUrl,
  restartWorkspaceRunConfiguration,
  startWorkspaceRunConfiguration,
  stopWorkspaceRunConfiguration,
} from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";
import { startWorkspaceRunDetection } from "./workspace-run-detection-state";
import {
  WorkspaceRunDetails,
  type WorkspaceRunAction,
} from "./workspace-run-details";
import { WorkspaceRunEditor } from "./workspace-run-editor";
import { WorkspaceRunList } from "./workspace-run-list";
import {
  applyWorkspaceRunLogBatch,
  mergeWorkspaceRunSnapshotLogs,
  workspaceRunInitialInputValues,
  workspaceRunInputErrors,
  workspaceRunIsActive,
  workspaceRunPrimaryStatus,
  workspaceRunStatusInputs,
} from "./workspace-run-model";

const RUN_RECONCILIATION_IDLE_MS = 10_000;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const documentFromSnapshot = (
  snapshot: WorkspaceRunSnapshot,
): WorkspaceRunConfigurationDocument => ({
  schemaVersion: WORKSPACE_RUN_SCHEMA_VERSION,
  inputs: snapshot.inputs,
  configurations: snapshot.configurations.map((status) => status.configuration),
});

const keepSelection = (
  current: string | null,
  snapshot: WorkspaceRunSnapshot,
): string | null =>
  current &&
  snapshot.configurations.some((status) => status.configuration.id === current)
    ? current
    : (workspaceRunPrimaryStatus(snapshot)?.configuration.id ?? null);

export const WorkspaceRunPanel = ({
  workspaceRoot,
  onDocumentDirtyChange,
}: {
  workspaceRoot: string | null | undefined;
  onDocumentDirtyChange?: (dirty: boolean) => void;
}): JSX.Element | null => {
  const normalizedRoot = workspaceRoot?.trim() || null;
  const rootKey = normalizedRoot
    ? createWorkspaceRootKey(normalizedRoot)
    : null;
  const activeRootKeyRef = useRef(rootKey);
  activeRootKeyRef.current = rootKey;
  const pendingActionsRef = useRef(new Set<string>());
  const lastRunEventAtRef = useRef(0);
  const documentDirtyRef = useRef(false);
  const [snapshot, setSnapshot] = useState<WorkspaceRunSnapshot | null>(null);
  const [document, setDocument] =
    useState<WorkspaceRunConfigurationDocument | null>(null);
  const [selectedConfigurationId, setSelectedConfigurationId] = useState<
    string | null
  >(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyActions, setBusyActions] = useState<
    Record<string, WorkspaceRunAction>
  >({});
  const [editedInputValues, setEditedInputValues] = useState<
    Record<string, WorkspaceRunInputValues>
  >({});
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detectionCompletionRevision, setDetectionCompletionRevision] =
    useState(0);
  const handleDocumentDirtyChange = useCallback(
    (dirty: boolean): void => {
      documentDirtyRef.current = dirty;
      onDocumentDirtyChange?.(dirty);
    },
    [onDocumentDirtyChange],
  );
  const handleDetectionComplete = useCallback((): void => {
    setDetectionCompletionRevision((current) => current + 1);
  }, []);
  const dismissDetectionCompletion = useCallback((): void => {
    setDetectionCompletionRevision(0);
  }, []);

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    if (!normalizedRoot || !rootKey) return;
    try {
      const next = await loadWorkspaceRunSnapshot(normalizedRoot);
      if (activeRootKeyRef.current !== rootKey) return;
      setSnapshot((current) =>
        current ? mergeWorkspaceRunSnapshotLogs(current, next) : next,
      );
      setSelectedConfigurationId((current) => keepSelection(current, next));
      setSnapshotError(null);
    } catch (cause) {
      if (activeRootKeyRef.current === rootKey) {
        setSnapshotError(errorMessage(cause));
      }
    }
  }, [normalizedRoot, rootKey]);

  const loadPanel = useCallback(async (): Promise<void> => {
    if (!normalizedRoot || !rootKey) return;
    setLoading(true);
    const [snapshotResult, documentResult] = await Promise.allSettled([
      loadWorkspaceRunSnapshot(normalizedRoot),
      loadWorkspaceRunConfigurationDocument(normalizedRoot),
    ]);
    if (activeRootKeyRef.current !== rootKey) return;

    if (snapshotResult.status === "fulfilled") {
      setSnapshot(snapshotResult.value);
      setSelectedConfigurationId((current) =>
        keepSelection(current, snapshotResult.value),
      );
      setSnapshotError(null);
    } else {
      setSnapshotError(errorMessage(snapshotResult.reason));
    }

    if (documentResult.status === "fulfilled") {
      setDocument(documentResult.value);
      setDocumentError(null);
    } else {
      setDocument((current) => current ?? createEmptyWorkspaceRunDocument());
      setDocumentError(errorMessage(documentResult.reason));
      setEditing(true);
    }
    setLoading(false);
  }, [normalizedRoot, rootKey]);

  useEffect(() => {
    pendingActionsRef.current.clear();
    documentDirtyRef.current = false;
    setSnapshot(null);
    setDocument(null);
    setSelectedConfigurationId(null);
    setQuery("");
    setEditing(false);
    setSnapshotError(null);
    setDocumentError(null);
    setActionError(null);
    setDetectionCompletionRevision(0);
    setBusyActions({});
    setEditedInputValues({});
    if (!normalizedRoot || !rootKey) {
      setLoading(false);
      return;
    }

    let active = true;
    lastRunEventAtRef.current = Date.now();
    void loadPanel();
    const interval = window.setInterval(() => {
      if (
        active &&
        Date.now() - lastRunEventAtRef.current >= RUN_RECONCILIATION_IDLE_MS
      ) {
        lastRunEventAtRef.current = Date.now();
        void refreshSnapshot();
      }
    }, 5_000);
    let unlisten: (() => void) | undefined;
    let unlistenLogs: (() => void) | undefined;
    void listenWorkspaceRunState((nextSnapshot) => {
      if (
        !active ||
        activeRootKeyRef.current !== rootKey ||
        createWorkspaceRootKey(nextSnapshot.workspaceRoot) !== rootKey
      ) {
        return;
      }
      lastRunEventAtRef.current = Date.now();
      setSnapshot((current) =>
        current
          ? mergeWorkspaceRunSnapshotLogs(current, nextSnapshot)
          : nextSnapshot,
      );
      if (!documentDirtyRef.current) {
        setDocument(documentFromSnapshot(nextSnapshot));
      }
      setSelectedConfigurationId((current) =>
        keepSelection(current, nextSnapshot),
      );
      setSnapshotError(null);
    }, normalizedRoot)
      .then((listener) => {
        if (active) unlisten = listener;
        else listener();
      })
      .catch(() => undefined);
    void listenWorkspaceRunLogs((batch) => {
      if (
        active &&
        activeRootKeyRef.current === rootKey &&
        createWorkspaceRootKey(batch.workspaceRoot) === rootKey
      ) {
        lastRunEventAtRef.current = Date.now();
        setSnapshot((current) =>
          current ? applyWorkspaceRunLogBatch(current, batch) : current,
        );
      }
    })
      .then((listener) => {
        if (active) unlistenLogs = listener;
        else listener();
      })
      .catch(() => undefined);

    return () => {
      active = false;
      window.clearInterval(interval);
      unlisten?.();
      unlistenLogs?.();
    };
  }, [loadPanel, normalizedRoot, refreshSnapshot, rootKey]);

  const statuses = useMemo(
    () => snapshot?.configurations ?? [],
    [snapshot?.configurations],
  );
  const inputs = useMemo(() => snapshot?.inputs ?? [], [snapshot?.inputs]);
  const selectedStatus =
    statuses.find(
      (status) => status.configuration.id === selectedConfigurationId,
    ) ??
    workspaceRunPrimaryStatus(snapshot) ??
    statuses[0] ??
    null;

  if (!normalizedRoot) return null;

  const statusInputValues = (
    status: WorkspaceRunConfigurationStatus,
  ): WorkspaceRunInputValues => {
    const statusInputs = workspaceRunStatusInputs(status, inputs);
    const defaults = workspaceRunInitialInputValues(statusInputs);
    const edited = editedInputValues[status.configuration.id];
    if (edited) return { ...defaults, ...edited };
    if (!workspaceRunIsActive(status)) return defaults;
    return Object.fromEntries(
      statusInputs.map((input) => [
        input.id,
        status.inputValues[input.id] ?? defaults[input.id]!,
      ]),
    );
  };

  const runAction = async (
    status: WorkspaceRunConfigurationStatus,
    action: WorkspaceRunAction,
  ): Promise<void> => {
    const configurationId = status.configuration.id;
    if (pendingActionsRef.current.has(configurationId)) return;
    const statusInputs = workspaceRunStatusInputs(status, inputs);
    const values = statusInputValues(status);
    if (
      action !== "stop" &&
      Object.keys(workspaceRunInputErrors(statusInputs, values)).length > 0
    ) {
      setSelectedConfigurationId(configurationId);
      return;
    }
    const actionRootKey = rootKey;
    pendingActionsRef.current.add(configurationId);
    setBusyActions((current) => ({ ...current, [configurationId]: action }));
    setActionError(null);
    try {
      const next =
        action === "start"
          ? await startWorkspaceRunConfiguration(
              normalizedRoot,
              configurationId,
              statusInputs.length > 0 ? values : undefined,
            )
          : action === "stop"
            ? await stopWorkspaceRunConfiguration(
                normalizedRoot,
                configurationId,
              )
            : await restartWorkspaceRunConfiguration(
                normalizedRoot,
                configurationId,
                editedInputValues[configurationId] ? values : undefined,
              );
      if (activeRootKeyRef.current === actionRootKey) {
        setSnapshot((current) =>
          current ? mergeWorkspaceRunSnapshotLogs(current, next) : next,
        );
      }
    } catch (cause) {
      if (activeRootKeyRef.current === actionRootKey) {
        setActionError(errorMessage(cause));
      }
    } finally {
      pendingActionsRef.current.delete(configurationId);
      if (activeRootKeyRef.current === actionRootKey) {
        setBusyActions((current) => {
          const { [configurationId]: _finished, ...remaining } = current;
          return remaining;
        });
      }
    }
  };

  const leaveEditor = (): void => {
    if (
      documentDirtyRef.current &&
      !window.confirm("Discard unsaved run configuration changes?")
    ) {
      return;
    }
    handleDocumentDirtyChange(false);
    setEditing(false);
  };

  const detect = (): void => {
    setEditing(true);
    void startWorkspaceRunDetection(normalizedRoot);
  };

  const loadError = documentError ?? snapshotError;
  const error = actionError ?? loadError;
  const showEditor = editing;
  const empty = Boolean(document && document.configurations.length === 0);

  const editor = document ? (
    <WorkspaceRunEditor
      workspaceRoot={normalizedRoot}
      document={document}
      onDirtyChange={handleDocumentDirtyChange}
      onDetectionComplete={handleDetectionComplete}
      onSaved={(nextDocument, nextSnapshot) => {
        setDocument(nextDocument);
        setSnapshot(nextSnapshot);
        setSelectedConfigurationId((current) =>
          keepSelection(current, nextSnapshot),
        );
        setEditedInputValues({});
        setDocumentError(null);
        setSnapshotError(null);
        setActionError(null);
      }}
    />
  ) : null;

  const errorBanner = error ? (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-red-900/50 bg-red-950/20 px-4 py-2 text-xs text-red-200"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{error}</span>
      {loadError ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={loading}
          onClick={() => void loadPanel()}
        >
          Retry
        </Button>
      ) : null}
    </div>
  ) : null;

  const detectionNotice =
    detectionCompletionRevision > 0 ? (
      <AppNotification
        key={detectionCompletionRevision}
        tone="success"
        onDismiss={dismissDetectionCompletion}
      >
        Run configuration detected and saved.
      </AppNotification>
    ) : null;

  const selectedInputs = selectedStatus
    ? workspaceRunStatusInputs(selectedStatus, inputs)
    : [];
  const selectedValues = selectedStatus ? statusInputValues(selectedStatus) : {};

  return (
    <section
      aria-label="Workspace run"
      aria-busy={loading}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20 sm:flex-row"
    >
      {!empty ? (
        <aside className="flex max-h-56 min-h-0 shrink-0 flex-col border-b border-slate-800 bg-slate-950/40 sm:max-h-none sm:w-64 sm:border-r sm:border-b-0">
          <WorkspaceRunList
            statuses={statuses}
            selectedConfigurationId={showEditor ? null : selectedStatus?.configuration.id ?? null}
            query={query}
            busyConfigurationIds={new Set(Object.keys(busyActions))}
            configurationHasArguments={(status) =>
              workspaceRunStatusInputs(status, inputs).length > 0
            }
            onQueryChange={setQuery}
            onSelect={(configurationId) => {
              if (showEditor) {
                if (
                  documentDirtyRef.current &&
                  !window.confirm("Discard unsaved run configuration changes?")
                ) {
                  return;
                }
                handleDocumentDirtyChange(false);
                setEditing(false);
              }
              setSelectedConfigurationId(configurationId);
            }}
            onQuickAction={(configurationId, action) => {
              const status = statuses.find(
                (candidate) => candidate.configuration.id === configurationId,
              );
              if (status) void runAction(status, action);
            }}
          />
          <div className="shrink-0 border-t border-slate-800 p-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={editing}
              onClick={() => (editing ? leaveEditor() : setEditing(true))}
              className="w-full justify-start text-slate-400 hover:text-slate-100"
            >
              <Settings2 aria-hidden="true" />
              Edit configuration
            </Button>
          </div>
        </aside>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {errorBanner}
        {showEditor ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={leaveEditor}
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
              <h2 className="text-sm font-medium text-slate-200">
                Configuration
              </h2>
            </div>
            <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4">
              {detectionNotice}
              {editor}
            </div>
          </div>
        ) : loading && !snapshot ? (
          <div className="grid flex-1 place-items-center">
            <LoaderCircle
              aria-label="Loading run state"
              className="size-5 animate-spin text-slate-500"
            />
          </div>
        ) : empty ? (
          <div className="grid flex-1 place-items-center p-6">
            <EmptyState
              icon={Play}
              title="No run configurations"
              className="w-full max-w-md"
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button type="button" size="sm" onClick={detect}>
                    <Sparkles aria-hidden="true" />
                    Detect
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(true)}
                  >
                    <Settings2 aria-hidden="true" />
                    Edit configuration
                  </Button>
                </div>
              }
            />
          </div>
        ) : selectedStatus ? (
          <WorkspaceRunDetails
            key={selectedStatus.configuration.id}
            status={selectedStatus}
            inputs={selectedInputs}
            values={selectedValues}
            errors={workspaceRunInputErrors(selectedInputs, selectedValues)}
            busyAction={busyActions[selectedStatus.configuration.id] ?? null}
            onValuesChange={(values) =>
              setEditedInputValues((current) => ({
                ...current,
                [selectedStatus.configuration.id]: values,
              }))
            }
            onAction={(action) => void runAction(selectedStatus, action)}
            onSelectConfiguration={setSelectedConfigurationId}
            onOpenUrl={(url) => {
              setActionError(null);
              const source = [selectedStatus, ...selectedStatus.children].find(
                (status) =>
                  status.configuration.kind === "task" &&
                  status.configuration.urls.includes(url),
              );
              void openWorkspaceRunUrl(
                normalizedRoot,
                (source ?? selectedStatus).configuration.id,
                url,
              ).catch((cause) => setActionError(errorMessage(cause)));
            }}
          />
        ) : null}
      </div>
    </section>
  );
};
