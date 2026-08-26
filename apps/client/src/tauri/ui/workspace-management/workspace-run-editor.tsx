import { LoaderCircle, Save, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useState, type JSX } from "react";
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
} from "./workspace-run-detection-state";

export const WorkspaceRunEditor = ({
  workspaceRoot,
  document,
  onDirtyChange,
  onSaved,
}: {
  workspaceRoot: string;
  document: WorkspaceRunConfigurationDocument;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved: (
    document: WorkspaceRunConfigurationDocument,
    snapshot: WorkspaceRunSnapshot,
  ) => void;
}): JSX.Element => {
  const serializedDocument = useMemo(
    () => JSON.stringify(document, null, 2),
    [document],
  );
  const [draft, setDraft] = useState(serializedDocument);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const detectionState = useWorkspaceRunDetectionState(workspaceRoot);
  const errorId = useId();
  const dirty = draft !== serializedDocument;
  const busy =
    detectionState.phase === "detecting" ? "detect" : saving ? "save" : null;
  const detections = detectionState.result?.detections ?? [];
  const error = saveError ?? detectionState.error;

  useEffect(() => {
    setDraft(serializedDocument);
  }, [serializedDocument]);

  useEffect(() => {
    if (!detectionState.result) return;
    const nextDraft = JSON.stringify(detectionState.result.document, null, 2);
    setDraft(nextDraft);
    onDirtyChange?.(nextDraft !== serializedDocument);
  }, [
    detectionState.phase,
    detectionState.result,
    detectionState.revision,
    onDirtyChange,
    serializedDocument,
  ]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const detect = (): void => {
    if (
      dirty &&
      !window.confirm(
        "Replace the unsaved run configuration with detected settings?",
      )
    ) {
      return;
    }
    setSaveError(null);
    void startWorkspaceRunDetection(workspaceRoot);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const checkedDocument = await precheckWorkspaceRunConfigurationJson(
        workspaceRoot,
        draft,
      );
      const snapshot = await saveWorkspaceRunConfigurationDocument(
        workspaceRoot,
        checkedDocument,
      );
      clearWorkspaceRunDetection(workspaceRoot);
      onDirtyChange?.(false);
      onSaved(checkedDocument, snapshot);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
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
            disabled={busy !== null}
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
            Detect
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
        {detections.some(
          (detection) => detection.uncertainFields.length > 0,
        ) ? (
          <div className="grid gap-1 text-xs text-amber-200">
            {detections
              .filter((detection) => detection.uncertainFields.length > 0)
              .map((detection) => (
                <div key={detection.configurationId}>
                  {detection.configurationId}: review{" "}
                  {detection.uncertainFields
                    .map((field) =>
                      field === "healthCheck" ? "health check" : field,
                    )
                    .join(", ")}
                </div>
              ))}
          </div>
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
          spellCheck={false}
          onChange={(event) => {
            const nextDraft = event.currentTarget.value;
            setDraft(nextDraft);
            onDirtyChange?.(nextDraft !== serializedDocument);
            setSaveError(null);
            clearWorkspaceRunDetection(workspaceRoot);
          }}
          className="min-h-72 max-h-[min(32rem,55vh)] resize-y overflow-auto border-slate-800 bg-slate-950 font-mono text-xs leading-5 text-slate-200"
        />
      </div>
    </SubmitShortcut>
  );
};
