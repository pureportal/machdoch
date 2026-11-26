import { ArrowLeft, LoaderCircle, Save, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
  WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { ChoiceButtons } from "../chat-session/components/settings-dialog-panels/shared";
import {
  precheckWorkspaceRunConfigurationJson,
  saveWorkspaceRunConfigurationDocument,
} from "../runtime";
import {
  clearWorkspaceRunDetection,
  startWorkspaceRunDetection,
  useWorkspaceRunDetectionState,
} from "./workspace-run-detection-state";
import {
  parseWorkspaceRunDraft,
  serializeWorkspaceRunDocument,
  workspaceRunConfigurationIssues,
  type WorkspaceRunDraftParseResult,
} from "./workspace-run-editor-model";
import { WorkspaceRunForm } from "./workspace-run-form";
import {
  RunFieldDraftContext,
  type RunFieldDraft,
} from "./workspace-run-form-fields";
import { createWorkspaceRootKey } from "./workspace-management-model";
import { formatWorkspaceRunDuration } from "./workspace-run-model";

type EditorMode = "form" | "json";

const EDITOR_MODE_OPTIONS = [
  { value: "form", label: "Form" },
  { value: "json", label: "JSON" },
] as const;

interface WorkspaceRunEditorProps {
  workspaceRoot: string;
  document: WorkspaceRunConfigurationDocument;
  initialSelectedId?: string | null;
  onBack?: () => void;
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
  initialSelectedId = null,
  onBack,
  onDirtyChange,
  onDetectionComplete,
  onSaved,
}: WorkspaceRunEditorProps): JSX.Element => {
  const serializedDocument = useMemo(
    () => serializeWorkspaceRunDocument(document),
    [document],
  );
  const [draftState, setDraftState] = useState<
    WorkspaceRunDraftParseResult & { text: string }
  >({
    text: serializedDocument,
    document,
    error: null,
  });
  const draft = draftState.text;
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, RunFieldDraft>>(
    {},
  );
  const [baseline, setBaseline] = useState(serializedDocument);
  const [mode, setMode] = useState<EditorMode>("form");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const previousDocumentRef = useRef(serializedDocument);
  const lifecycleRef = useRef(0);
  const savingRef = useRef(false);
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;
  const [detections, setDetections] = useState<WorkspaceRunDetection[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const detectionState = useWorkspaceRunDetectionState(workspaceRoot);
  const [detectionElapsed, setDetectionElapsed] = useState(0);
  const errorId = useId();
  const parsed = draftState;
  const schemaError = useMemo(
    () => parseWorkspaceRunDraft(draft).error,
    [draft],
  );
  const effectiveMode: EditorMode = parsed.document ? mode : "json";
  const invalidField = Object.values(fieldDrafts).find((field) => field.error);
  const dirty = draft !== baseline || Boolean(invalidField);
  const busy =
    detectionState.phase === "detecting" ? "detect" : saving ? "save" : null;
  const issueCount = parsed.document
    ? workspaceRunConfigurationIssues(parsed.document).length
    : 0;
  const error =
    saveError ??
    detectionState.error ??
    invalidField?.error ??
    (effectiveMode === "form" && issueCount === 0 ? schemaError : null);

  useEffect(() => {
    const previous = previousDocumentRef.current;
    previousDocumentRef.current = serializedDocument;
    setDraftState((current) =>
      current.text === previous
        ? { text: serializedDocument, document, error: null }
        : current,
    );
    setBaseline(serializedDocument);
  }, [document, serializedDocument]);

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
    const nextDraft = serializeWorkspaceRunDocument(
      detectionState.result.document,
    );
    setDraftState({
      text: nextDraft,
      document: detectionState.result.document,
      error: null,
    });
    setFieldDrafts({});
    setBaseline(nextDraft);
    setSelectedId(null);
    setDetections(detectionState.result.detections);
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

  useEffect(() => {
    if (detectionState.phase !== "detecting") return;
    const startedAt = Date.now();
    setDetectionElapsed(0);
    const interval = window.setInterval(
      () => setDetectionElapsed(Date.now() - startedAt),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, [detectionState.phase, detectionState.revision]);

  const updateDraft = (nextDraft: string): void => {
    if (savingRef.current || busy) return;
    setDraftState({ text: nextDraft, ...parseWorkspaceRunDraft(nextDraft) });
    setFieldDrafts({});
    setSaveError(null);
    setDetections([]);
    clearWorkspaceRunDetection(workspaceRoot);
  };

  const updateDocument = (next: WorkspaceRunConfigurationDocument): void => {
    if (savingRef.current || busy) return;
    setDraftState({
      text: serializeWorkspaceRunDocument(next),
      document: next,
      error: null,
    });
    const activeFields = new Set([
      ...next.configurations.flatMap((configuration) =>
        configuration.kind === "task"
          ? ["ports", "urls", "environment"].map(
              (field) => `task:${configuration.id}:${field}`,
            )
          : [],
      ),
      ...next.inputs
        .filter((input) => input.type === "select")
        .map((input) => `input:${input.id}:options`),
    ]);
    setFieldDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => activeFields.has(key)),
      ),
    );
    setSaveError(null);
    setDetections([]);
    clearWorkspaceRunDetection(workspaceRoot);
  };

  const detect = (): void => {
    if (savingRef.current || busy || dirty) return;
    setSaveError(null);
    void startWorkspaceRunDetection(workspaceRoot);
  };

  const save = async (): Promise<void> => {
    if (savingRef.current || busy || invalidField || schemaError) return;
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
      const savedDraft = serializeWorkspaceRunDocument(checkedDocument);
      setDraftState({
        text: savedDraft,
        document: checkedDocument,
        error: null,
      });
      setFieldDrafts({});
      setBaseline(savedDraft);
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
      <div aria-busy={busy !== null} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
          {onBack ? (
            <Button type="button" size="sm" variant="ghost" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Button>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
            Run configuration
          </h2>
          <ChoiceButtons
            label="Editor mode"
            value={effectiveMode}
            options={EDITOR_MODE_OPTIONS}
            disabled={!parsed.document || Boolean(invalidField)}
            onChange={(next) => {
              setFieldDrafts({});
              setMode(next);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null || dirty}
            tooltip={dirty ? "Save or discard changes first." : undefined}
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
            {busy === "detect"
              ? `Detecting ${formatWorkspaceRunDuration(detectionElapsed)}`
              : "Detect"}
          </Button>
          {dirty ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setDraftState({
                  text: baseline,
                  ...parseWorkspaceRunDraft(baseline),
                });
                setFieldDrafts({});
                setSaveError(null);
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={
              busy !== null ||
              !dirty ||
              issueCount > 0 ||
              Boolean(invalidField) ||
              schemaError !== null
            }
            tooltip={
              issueCount > 0
                ? "Fix the highlighted configurations first."
                : undefined
            }
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
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="shrink-0 border-b border-red-900/50 bg-red-950/20 px-4 py-2 text-xs text-red-200"
          >
            {error}
          </p>
        ) : null}
        {effectiveMode === "form" && parsed.document ? (
          <RunFieldDraftContext.Provider
            value={{
              values: fieldDrafts,
              onChange: (key, field) =>
                setFieldDrafts((current) => ({ ...current, [key]: field })),
            }}
          >
            <WorkspaceRunForm
              document={parsed.document}
              selectedId={selectedId}
              detections={detections}
              disabled={busy !== null}
              onSelect={setSelectedId}
              onChange={updateDocument}
            />
          </RunFieldDraftContext.Provider>
        ) : (
          <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-4">
            {parsed.error ? (
              <p role="alert" className="text-xs text-red-300">
                {parsed.error}
              </p>
            ) : null}
            <Textarea
              aria-label="Run configuration JSON"
              aria-invalid={error !== null || parsed.error !== null}
              aria-describedby={error ? errorId : undefined}
              value={draft}
              disabled={busy !== null}
              spellCheck={false}
              onChange={(event) => updateDraft(event.currentTarget.value)}
              className="min-h-[28rem] resize-y border-slate-800 bg-slate-950 font-mono text-xs leading-5 text-slate-200"
            />
          </div>
        )}
      </div>
    </SubmitShortcut>
  );
};
