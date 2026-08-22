import {
  ChevronDown,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Play,
  RotateCw,
  Square,
} from "lucide-react";
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
  type WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
  listenWorkspaceRunLogs,
  listenWorkspaceRunState,
  loadWorkspaceRunConfigurationDocument,
  loadWorkspaceRunSnapshot,
  openExternalUrl,
  restartWorkspaceRunConfiguration,
  startWorkspaceRunConfiguration,
  stopWorkspaceRunConfiguration,
} from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";
import { WorkspaceRunEditor } from "./workspace-run-editor";
import {
  applyWorkspaceRunLogBatch,
  mergeWorkspaceRunSnapshotLogs,
  workspaceRunCanRestart,
  workspaceRunConfigurationLabel,
  workspaceRunCurrentFailure,
  workspaceRunDirectAction,
  workspaceRunIsActive,
  workspaceRunPrimaryStatus,
  workspaceRunStatusPorts,
  workspaceRunStatusPresentation,
  workspaceRunStatusUrls,
} from "./workspace-run-model";
import { WorkspaceRunOutput } from "./workspace-run-output";

const STATE_TONE_CLASS = {
  idle: "bg-slate-500",
  progress: "bg-sky-400",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-red-400",
} as const;
const RUN_RECONCILIATION_IDLE_MS = 10_000;

export type WorkspaceRunPanelView =
  | "all"
  | "summary"
  | "output"
  | "configuration";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const hasOutput = (status: WorkspaceRunConfigurationStatus): boolean =>
  status.logs.length > 0 || status.children.some(hasOutput);

const ConfigurationSummary = ({
  status,
  onOpenUrl,
}: {
  status: WorkspaceRunConfigurationStatus;
  onOpenUrl: (url: string) => void;
}): JSX.Element | null => {
  const ports = workspaceRunStatusPorts(status);
  const urls = workspaceRunStatusUrls(status);
  const failure = workspaceRunCurrentFailure(status);
  const failedHealth = [status, ...status.children]
    .filter((candidate) => candidate.health?.state === "failed")
    .sort(
      (left, right) =>
        (right.health?.checkedAt ?? 0) - (left.health?.checkedAt ?? 0),
    )[0]?.health;
  const diagnostic = failure?.message ?? failedHealth?.message;
  if (
    status.children.length === 0 &&
    ports.length === 0 &&
    urls.length === 0 &&
    status.restartCount === 0 &&
    !diagnostic
  ) {
    return null;
  }

  return (
    <div className="grid gap-2 border-t border-slate-800 px-3 py-2.5 text-xs">
      {status.children.length > 0 ? (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {status.children.map((child) => {
            const presentation = workspaceRunStatusPresentation(child);
            return (
              <div
                key={child.configuration.id}
                className="flex min-w-0 items-center gap-2 rounded-md border border-slate-800/80 px-2.5 py-2"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    STATE_TONE_CLASS[presentation.tone],
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-slate-300">
                  {workspaceRunConfigurationLabel(child, status.children)}
                </span>
                <span className="shrink-0 text-slate-500">
                  {presentation.label}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {ports.length > 0 || urls.length > 0 || status.restartCount > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
          {ports.length > 0 ? <span>Ports {ports.join(", ")}</span> : null}
          {status.restartCount > 0 ? (
            <span>
              {status.restartCount} restart
              {status.restartCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {urls.map((url) => (
            <button
              key={url}
              type="button"
              className="inline-flex max-w-full items-center gap-1 text-sky-300 outline-none hover:text-sky-200 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-sky-500"
              onClick={() => onOpenUrl(url)}
            >
              <span className="truncate">{url}</span>
              <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
            </button>
          ))}
        </div>
      ) : null}
      {diagnostic ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-900/60 bg-red-950/25 px-2.5 py-2 text-red-200"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0 break-words">{diagnostic}</span>
        </div>
      ) : null}
    </div>
  );
};

export const WorkspaceRunPanel = ({
  workspaceRoot,
  view,
  onDocumentDirtyChange,
  onConfigurationRequired,
}: {
  workspaceRoot: string | null | undefined;
  view: WorkspaceRunPanelView;
  onDocumentDirtyChange?: (dirty: boolean) => void;
  onConfigurationRequired?: () => void;
}): JSX.Element | null => {
  const normalizedRoot = workspaceRoot?.trim() || null;
  const rootKey = normalizedRoot
    ? createWorkspaceRootKey(normalizedRoot)
    : null;
  const activeRootKeyRef = useRef(rootKey);
  activeRootKeyRef.current = rootKey;
  const actionTokenRef = useRef<symbol | null>(null);
  const lastRunEventAtRef = useRef(0);
  const documentDirtyRef = useRef(false);
  const documentRootKeyRef = useRef<string | null>(null);
  const configurationRequestRootKeyRef = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceRunSnapshot | null>(null);
  const [document, setDocument] =
    useState<WorkspaceRunConfigurationDocument | null>(null);
  const [selectedConfigurationId, setSelectedConfigurationId] = useState<
    string | null
  >(null);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "start" | "stop" | "restart" | null
  >(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const handleDocumentDirtyChange = useCallback(
    (dirty: boolean): void => {
      documentDirtyRef.current = dirty;
      onDocumentDirtyChange?.(dirty);
    },
    [onDocumentDirtyChange],
  );

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    if (!normalizedRoot || !rootKey) return;
    try {
      const next = await loadWorkspaceRunSnapshot(normalizedRoot);
      if (activeRootKeyRef.current !== rootKey) return;
      setSnapshot((current) =>
        current ? mergeWorkspaceRunSnapshotLogs(current, next) : next,
      );
      setSelectedConfigurationId((current) =>
        current &&
        next.configurations.some(
          (status) => status.configuration.id === current,
        )
          ? current
          : next.primaryConfigurationId,
      );
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
        current &&
        snapshotResult.value.configurations.some(
          (status) => status.configuration.id === current,
        )
          ? current
          : snapshotResult.value.primaryConfigurationId,
      );
      setSnapshotError(null);
    } else {
      setSnapshotError(errorMessage(snapshotResult.reason));
    }

    if (documentResult.status === "fulfilled") {
      documentRootKeyRef.current = rootKey;
      setDocument(documentResult.value);
      setDocumentError(null);
      if (documentResult.value.configurations.length === 0) {
        setConfigurationOpen(true);
      }
    } else {
      documentRootKeyRef.current = rootKey;
      setDocument((current) => current ?? createEmptyWorkspaceRunDocument());
      setDocumentError(errorMessage(documentResult.reason));
      setConfigurationOpen(true);
    }
    setLoading(false);
  }, [normalizedRoot, rootKey]);

  useEffect(() => {
    actionTokenRef.current = null;
    documentDirtyRef.current = false;
    documentRootKeyRef.current = null;
    configurationRequestRootKeyRef.current = null;
    setSnapshot(null);
    setDocument(null);
    setSelectedConfigurationId(null);
    setConfigurationOpen(false);
    setSnapshotError(null);
    setDocumentError(null);
    setActionError(null);
    setBusyAction(null);
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
        active &&
        activeRootKeyRef.current === rootKey &&
        createWorkspaceRootKey(nextSnapshot.workspaceRoot) === rootKey
      ) {
        lastRunEventAtRef.current = Date.now();
        setSnapshot((current) =>
          current
            ? mergeWorkspaceRunSnapshotLogs(current, nextSnapshot)
            : nextSnapshot,
        );
        if (!documentDirtyRef.current) {
          documentRootKeyRef.current = rootKey;
          setDocument({
            schemaVersion: WORKSPACE_RUN_SCHEMA_VERSION,
            primaryConfigurationId: nextSnapshot.primaryConfigurationId,
            configurations: nextSnapshot.configurations.map(
              (status) => status.configuration,
            ),
          });
        }
        setSelectedConfigurationId((current) =>
          current &&
          nextSnapshot.configurations.some(
            (status) => status.configuration.id === current,
          )
            ? current
            : nextSnapshot.primaryConfigurationId,
        );
        setSnapshotError(null);
      }
    })
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

  useEffect(() => {
    if (
      view !== "all" &&
      !loading &&
      document &&
      documentRootKeyRef.current === rootKey &&
      document.configurations.length === 0 &&
      onConfigurationRequired &&
      configurationRequestRootKeyRef.current !== rootKey
    ) {
      configurationRequestRootKeyRef.current = rootKey;
      onConfigurationRequired();
    }
  }, [document, loading, onConfigurationRequired, rootKey, view]);

  const primaryStatus = workspaceRunPrimaryStatus(snapshot);
  const displayedStatus = useMemo(() => {
    if (!snapshot) return null;
    return (
      snapshot.configurations.find(
        (status) => status.configuration.id === selectedConfigurationId,
      ) ?? primaryStatus
    );
  }, [primaryStatus, selectedConfigurationId, snapshot]);

  if (!normalizedRoot) return null;

  const runAction = async (
    action: "start" | "stop" | "restart",
  ): Promise<void> => {
    if (!displayedStatus || actionTokenRef.current) return;
    const token = Symbol(action);
    const actionRootKey = rootKey;
    const configurationId = displayedStatus.configuration.id;
    actionTokenRef.current = token;
    setBusyAction(action);
    setActionError(null);
    try {
      const next =
        action === "start"
          ? await startWorkspaceRunConfiguration(
              normalizedRoot,
              configurationId,
            )
          : action === "stop"
            ? await stopWorkspaceRunConfiguration(
                normalizedRoot,
                configurationId,
              )
            : await restartWorkspaceRunConfiguration(
                normalizedRoot,
                configurationId,
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
      if (actionTokenRef.current === token) {
        actionTokenRef.current = null;
        setBusyAction(null);
      }
    }
  };

  const directAction = displayedStatus
    ? workspaceRunDirectAction(displayedStatus)
    : "none";
  const presentation = displayedStatus
    ? workspaceRunStatusPresentation(displayedStatus)
    : null;
  const loadError = documentError ?? snapshotError;
  const error = actionError ?? loadError;
  const showOutput = Boolean(
    displayedStatus &&
    (displayedStatus.startedAt !== null ||
      workspaceRunIsActive(displayedStatus) ||
      hasOutput(displayedStatus)),
  );
  const outputVisible = view === "output" || (view === "all" && showOutput);

  return (
    <section
      aria-label="Workspace run"
      aria-busy={loading || busyAction !== null}
      className={cn(
        "min-w-0",
        view !== "all" &&
          "overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20 shadow-[0_16px_48px_rgba(0,0,0,0.16)]",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-2.5",
          view === "all" ? "pb-4" : "px-4 py-3.5",
        )}
      >
        <Play aria-hidden="true" className="size-4 shrink-0 text-emerald-300" />
        <div className="min-w-[8rem] flex-1">
          {(snapshot?.configurations.length ?? 0) > 1 && displayedStatus ? (
            <select
              aria-label="Run configuration"
              value={displayedStatus.configuration.id}
              onChange={(event) =>
                setSelectedConfigurationId(event.currentTarget.value)
              }
              className="h-7 max-w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-sm font-medium text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
            >
              {snapshot?.configurations.map((status) => (
                <option
                  key={status.configuration.id}
                  value={status.configuration.id}
                >
                  {workspaceRunConfigurationLabel(
                    status,
                    snapshot?.configurations ?? [],
                  )}
                </option>
              ))}
            </select>
          ) : (
            <div className="truncate text-sm font-medium text-slate-100">
              {displayedStatus?.configuration.name ?? "Run"}
            </div>
          )}
          {presentation ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  STATE_TONE_CLASS[presentation.tone],
                  presentation.tone === "progress" && "animate-pulse",
                )}
              />
              {presentation.label}
            </div>
          ) : null}
        </div>
        {loading && !snapshot ? (
          <LoaderCircle
            aria-label="Loading run state"
            className="size-4 animate-spin text-slate-500"
          />
        ) : null}
        {displayedStatus && workspaceRunCanRestart(displayedStatus) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busyAction !== null}
            onClick={() => void runAction("restart")}
          >
            {busyAction === "restart" ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : (
              <RotateCw aria-hidden="true" className="size-4" />
            )}
            Restart
          </Button>
        ) : null}
        {directAction !== "none" && displayedStatus ? (
          <Button
            type="button"
            size="sm"
            variant={directAction === "start" ? "default" : "outline"}
            disabled={busyAction !== null}
            onClick={() => void runAction(directAction)}
          >
            {busyAction === directAction ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : directAction === "start" ? (
              <Play aria-hidden="true" className="size-4" />
            ) : (
              <Square aria-hidden="true" className="size-3.5 fill-current" />
            )}
            {directAction === "start" ? "Start" : "Stop"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-red-900/50 px-3 py-2 text-xs text-red-200"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
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
      ) : null}
      {displayedStatus ? (
        <ConfigurationSummary
          status={displayedStatus}
          onOpenUrl={(url) => {
            setActionError(null);
            void openExternalUrl(url).catch((cause) =>
              setActionError(errorMessage(cause)),
            );
          }}
        />
      ) : null}
      {displayedStatus ? (
        <div hidden={!outputVisible}>
          <WorkspaceRunOutput status={displayedStatus} compact={false} />
        </div>
      ) : null}
      {document && view === "all" ? (
        <details
          open={configurationOpen}
          onToggle={(event) => setConfigurationOpen(event.currentTarget.open)}
          className="group/config border-t border-slate-800/80"
        >
          <summary className="flex cursor-pointer list-none items-center px-3 py-2 text-xs text-slate-400 outline-none hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/70">
            Configuration
            <ChevronDown
              aria-hidden="true"
              className="ml-auto size-3.5 transition-transform group-open/config:rotate-180"
            />
          </summary>
          <div className="border-t border-slate-800 p-4">
            <WorkspaceRunEditor
              workspaceRoot={normalizedRoot}
              document={document}
              onDirtyChange={handleDocumentDirtyChange}
              onSaved={(nextDocument, nextSnapshot) => {
                setDocument(nextDocument);
                setSnapshot(nextSnapshot);
                setSelectedConfigurationId(nextSnapshot.primaryConfigurationId);
                setDocumentError(null);
                setSnapshotError(null);
                setActionError(null);
                setConfigurationOpen(false);
              }}
            />
          </div>
        </details>
      ) : null}
      {document && view !== "all" ? (
        <div
          hidden={view !== "configuration"}
          className="border-t border-slate-800 p-4"
        >
          <WorkspaceRunEditor
            workspaceRoot={normalizedRoot}
            document={document}
            onDirtyChange={handleDocumentDirtyChange}
            onSaved={(nextDocument, nextSnapshot) => {
              setDocument(nextDocument);
              setSnapshot(nextSnapshot);
              setSelectedConfigurationId(nextSnapshot.primaryConfigurationId);
              setDocumentError(null);
              setSnapshotError(null);
              setActionError(null);
            }}
          />
        </div>
      ) : null}
    </section>
  );
};
