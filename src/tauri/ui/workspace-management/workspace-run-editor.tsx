import { LoaderCircle, Save, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useState, type JSX } from "react";
import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
  WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  detectWorkspaceRunConfigurations,
  saveWorkspaceRunConfigurationDocument,
} from "../runtime";

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
  const [detections, setDetections] = useState<WorkspaceRunDetection[]>([]);
  const [busy, setBusy] = useState<"detect" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const dirty = draft !== serializedDocument;

  useEffect(() => {
    setDraft(serializedDocument);
  }, [serializedDocument]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const detect = async (): Promise<void> => {
    if (
      dirty &&
      !window.confirm(
        "Replace the unsaved run configuration with detected settings?",
      )
    ) {
      return;
    }
    setBusy("detect");
    setError(null);
    try {
      const result = await detectWorkspaceRunConfigurations(workspaceRoot);
      const nextDraft = JSON.stringify(result.document, null, 2);
      setDraft(nextDraft);
      onDirtyChange?.(nextDraft !== serializedDocument);
      setDetections(result.detections);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    setBusy("save");
    setError(null);
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Run configuration must be a JSON object.");
      }
      const snapshot = await saveWorkspaceRunConfigurationDocument(
        workspaceRoot,
        parsed as WorkspaceRunConfigurationDocument,
      );
      setDetections([]);
      onDirtyChange?.(false);
      onSaved(parsed as WorkspaceRunConfigurationDocument, snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div aria-busy={busy !== null} className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void detect()}
        >
          {busy === "detect" ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
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
        >
          {busy === "save" ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Save aria-hidden="true" className="size-4" />
          )}
          Save
        </Button>
      </div>
      {detections.some((detection) => detection.uncertainFields.length > 0) ? (
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
          setError(null);
        }}
        className="min-h-72 max-h-[min(32rem,55vh)] resize-y overflow-auto border-slate-800 bg-slate-950 font-mono text-xs leading-5 text-slate-200"
      />
    </div>
  );
};
