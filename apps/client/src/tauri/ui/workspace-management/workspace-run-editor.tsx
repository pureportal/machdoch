import { LoaderCircle, Save, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { Button } from "../components/ui/button";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../components/ui/submit-shortcut";
import { Textarea } from "../components/ui/textarea";
import {
  precheckWorkspaceRunConfigurationJson,
  saveWorkspaceRunConfigurationDocument,
} from "../runtime";
import {
  clearWorkspaceRunDetection,
  startWorkspaceRunDetection,
  useWorkspaceRunDetectionState,
  type WorkspaceRunDetectionResult,
} from "./workspace-run-detection-state";
import { createWorkspaceRootKey } from "./workspace-management-model";

interface WorkspaceRunEditorProps {
  workspaceRoot: string;
  document: WorkspaceRunConfigurationDocument;
  onDirtyChange?: (dirty: boolean) => void;
  onDetectionComplete?: () => void;
  onSaved: (
    document: WorkspaceRunConfigurationDocument,
    snapshot: WorkspaceRunSnapshot,
  ) => void;
}

export const WorkspaceRunEditor = (
  props: WorkspaceRunEditorProps,
): JSX.Element => (
  <WorkspaceRunEditorSession
    key={createWorkspaceRootKey(props.workspaceRoot)}
    {...props}
  />
);

const WorkspaceRunEditorSession = ({
  workspaceRoot,
  document,
  onDirtyChange,
  onDetectionComplete,
  onSaved,
}: WorkspaceRunEditorProps): JSX.Element => {
  const serializedDocument = useMemo(
    () => JSON.stringify(document, null, 2),
    [document],
  );
  const [draft, setDraft] = useState(serializedDocument);
  const [baseline, setBaseline] = useState(serializedDocument);
  const previousDocumentRef = useRef(serializedDocument);
  const lifecycleRef = useRef(0);
  const savingRef = useRef(false);
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;
  const [detected, setDetected] = useState<WorkspaceRunDetectionResult | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const detectionState = useWorkspaceRunDetectionState(workspaceRoot);
  const errorId = useId();
  const dirty = draft !== baseline;
  const busy =
    detectionState.phase === "detecting" ? "detect" : saving ? "save" : null;
  const error = saveError ?? detectionState.error;

  useEffect(() => {
    const previous = previousDocumentRef.current;
    previousDocumentRef.current = serializedDocument;
    // Background refreshes may update the saved document while the user edits.
    setDraft((current) =>
      current === previous ? serializedDocument : current,
    );
    setBaseline(serializedDocument);
  }, [serializedDocument]);

  useEffect(() => {
    lifecycleRef.current++;
    return () => {
      lifecycleRef.current++;
      dirtyCallbackRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    if (detectionState.phase !== "complete" || !detectionState.result) {
      return;
    }
    const nextDraft = JSON.stringify(detectionState.result.document, null, 2);
    setDetected(detectionState.result);
    setDraft(nextDraft);
    setBaseline(nextDraft);
    clearWorkspaceRunDetection(workspaceRoot);
    onDirtyChange?.(false);
    onDetectionComplete?.();
    onSaved(detectionState.result.document, detectionState.result.snapshot);
  }, [
    detectionState.phase,
    detectionState.result,
    detectionState.revision,
    onDetectionComplete,
    onDirtyChange,
    onSaved,
    workspaceRoot,
  ]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const detect = (): void => {
    if (savingRef.current || busy || dirty) return;
    setSaveError(null);
    void startWorkspaceRunDetection(workspaceRoot);
  };

  const save = async (): Promise<void> => {
    if (savingRef.current || busy) return;
    savingRef.current = true;
    const lifecycle = lifecycleRef.current;
    const isCurrent = () => lifecycleRef.current === lifecycle;
    setSaving(true);
    setSaveError(null);
    try {
      const checkedDocument = await precheckWorkspaceRunConfigurationJson(
        workspaceRoot,
        draft,
      );
      if (!isCurrent()) return;
      const snapshot = await saveWorkspaceRunConfigurationDocument(
        workspaceRoot,
        checkedDocument,
      );
      if (!isCurrent()) return;
      const savedDraft = JSON.stringify(checkedDocument, null, 2);
      setDraft(savedDraft);
      setBaseline(savedDraft);
      setDetected(null);
      clearWorkspaceRunDetection(workspaceRoot);
      onDirtyChange?.(false);
      onSaved(checkedDocument, snapshot);
    } catch (cause) {
      if (isCurrent())
        setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      if (isCurrent()) setSaving(false);
    }
  };

  return (
    <SubmitShortcut asChild>
      <div aria-busy={busy !== null} className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null || dirty}
            onClick={detect}
          >
            {busy === "detect" ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : (
              <Sparkles aria-hidden="true" className="size-4" />
            )}
            {busy === "detect" ? "Detecting" : "Detect"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => void save()}
            {...SUBMIT_SHORTCUT_ACTION_PROPS}
          >
            {busy === "save" ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : (
              <Save aria-hidden="true" className="size-4" />
            )}
            Save
          </Button>
        </div>
        {dirty ? (
          <p className="text-xs text-slate-400">
            Save your edits before detecting configurations.
          </p>
        ) : null}
        {detected ? (
          <section
            aria-label="Detected run configurations"
            className="grid gap-2 rounded-md border border-slate-800 p-3 text-xs"
          >
            {detected.document.configurations.map((configuration) => {
              const metadata = detected.detections.find(
                (entry) => entry.configurationId === configuration.id,
              );
              return (
                <div key={configuration.id} className="grid gap-1">
                  <div className="font-medium text-slate-200">
                    {configuration.name}
                    {configuration.primary ? (
                      <span className="ml-2 text-sky-300">Default</span>
                    ) : null}
                  </div>
                  <code className="break-all text-slate-400">
                    {configuration.kind === "task"
                      ? configuration.command
                      : configuration.children.join(", ")}
                  </code>
                  {metadata?.uncertainFields.map((field) => (
                    <span key={field} className="text-amber-300">
                      Review {field.charAt(0).toUpperCase() + field.slice(1)}
                    </span>
                  ))}
                </div>
              );
            })}
            {detected.document.configurations.length === 0 ? (
              <p>No runnable configurations were detected.</p>
            ) : null}
          </section>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="text-xs text-red-300">
            {error}
          </p>
        ) : null}
        <Textarea
          aria-label="Run configuration JSON"
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          value={draft}
          disabled={busy !== null}
          spellCheck={false}
          onChange={(event) => {
            if (savingRef.current || busy) return;
            const nextDraft = event.currentTarget.value;
            setDraft(nextDraft);
            onDirtyChange?.(nextDraft !== baseline);
            setDetected(null);
            setSaveError(null);
            clearWorkspaceRunDetection(workspaceRoot);
          }}
          className="min-h-72 max-h-[min(32rem,55vh)] resize-y overflow-auto border-slate-800 bg-slate-950 font-mono text-xs leading-5 text-slate-200"
        />
      </div>
    </SubmitShortcut>
  );
};
