import { CircleAlert, LoaderCircle, Save, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useState, type JSX } from "react";
import type {
  WorkspaceRunConfiguration,
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
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

const detectionFieldLabel = (field: string): string =>
  field
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (character) => character.toUpperCase());

const DetectedConfigurations = ({
  configurations,
  detections,
}: {
  configurations: readonly WorkspaceRunConfiguration[];
  detections: readonly WorkspaceRunDetection[];
}): JSX.Element => {
  const configurationNames = new Map(
    configurations.map((configuration) => [
      configuration.id,
      configuration.name,
    ]),
  );
  const detectionById = new Map(
    detections.map((detection) => [detection.configurationId, detection]),
  );

  return (
    <section aria-label="Detected run configurations" className="grid gap-2">
      <h3 className="text-xs font-medium text-slate-300">
        Detected configurations
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {configurations.map((configuration) => {
          const detection = detectionById.get(configuration.id);
          const needsReview =
            detection?.confidence === "medium" ||
            Boolean(detection?.uncertainFields.length);
          const details =
            configuration.kind === "task"
              ? configuration.command
              : configuration.children
                  .map((id) => configurationNames.get(id) ?? id)
                  .join(", ");

          return (
            <article
              key={configuration.id}
              className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/70 p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
                  {configuration.name}
                </span>
                {configuration.primary ? (
                  <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-200">
                    Default
                  </span>
                ) : null}
                {needsReview ? (
                  <span className="text-[10px] font-medium text-amber-200">
                    Review
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 truncate font-mono text-[11px] text-slate-400">
                {details}
              </div>
              {detection?.uncertainFields.length ? (
                <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-200">
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-3 shrink-0"
                  />
                  <span>
                    Review{" "}
                    {detection.uncertainFields
                      .map(detectionFieldLabel)
                      .join(", ")}
                  </span>
                </div>
              ) : null}
              {detection?.evidence.length ? (
                <details className="mt-2 text-[11px] text-slate-500">
                  <summary className="w-fit cursor-pointer select-none text-slate-400 outline-none hover:text-slate-200 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-sky-500/60">
                    Evidence
                  </summary>
                  <ul className="mt-1 grid list-disc gap-1 pl-4">
                    {detection.evidence.map((item, index) => (
                      <li key={`${index}:${item}`} className="break-words">
                        {item}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
};

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
  const detectedResult =
    detectionState.phase === "complete" ? detectionState.result : null;
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
        {detectedResult?.document.configurations.length ? (
          <DetectedConfigurations
            configurations={detectedResult.document.configurations}
            detections={detectedResult.detections}
          />
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
