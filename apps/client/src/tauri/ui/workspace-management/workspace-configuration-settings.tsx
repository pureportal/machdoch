import { isTauri } from "@tauri-apps/api/core";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Button } from "../components/ui/button";
import {
  loadWorkspaceRuntimeSnapshot,
  saveWorkspaceContextWindow,
  saveWorkspaceDefaultMode,
  saveWorkspaceMemoryOverride,
  saveWorkspaceReasoningExecutionMode,
  saveWorkspaceReasoningMode,
  type ContextWindow,
  type ReasoningExecutionMode,
  type ReasoningMode,
  type RuntimeSnapshot,
} from "../runtime";
import { WorkspaceSettingsPanel } from "../chat-session/components/settings-dialog-panels/workspace-settings-panel";
import type {
  SettingsStatusMessage,
  WorkspaceSettingsControls,
} from "../chat-session/components/settings-dialog-panels/types";

export interface WorkspaceConfigurationSettingsProps {
  workspaceRoot: string;
  workspaceLabel: string;
  workspaceMemoryDefaultEnabled: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSaved?: (workspaceRoot: string) => Promise<void> | void;
}

type WorkspaceConfigurationValues = Omit<
  WorkspaceSettingsControls,
  | "workspaceRoot"
  | "workspaceLabel"
  | "workspaceMemoryDefaultEnabled"
  | "saving"
  | "message"
  | "onDefaultModeChange"
  | "onWorkspaceMemoryOverrideChange"
  | "onReasoningModeChange"
  | "onReasoningExecutionModeChange"
  | "onContextWindowChange"
>;

const createWorkspaceConfigurationValues = (
  snapshot: RuntimeSnapshot,
): WorkspaceConfigurationValues => {
  const effectiveReasoningMode = snapshot.reasoningMode ?? "standard";
  const effectiveContextWindow = snapshot.contextWindow ?? "default";

  return {
    defaultMode: snapshot.defaultMode ?? snapshot.mode,
    effectiveMode: snapshot.mode,
    defaultReasoning: snapshot.defaultReasoning ?? snapshot.reasoning,
    effectiveReasoning: snapshot.reasoning,
    defaultReasoningExecutionMode:
      snapshot.defaultReasoningMode ?? effectiveReasoningMode,
    effectiveReasoningExecutionMode: effectiveReasoningMode,
    defaultContextWindow:
      snapshot.defaultContextWindow ?? effectiveContextWindow,
    effectiveContextWindow,
    workspaceMemoryOverride: snapshot.workspaceMemoryOverride,
    workspaceMemoryEnabled: snapshot.workspaceMemoryEnabled,
    reasoningProvider:
      snapshot.provider === "unconfigured" ? undefined : snapshot.provider,
    reasoningModel: snapshot.model,
  };
};

const createFallbackWorkspaceConfigurationValues = (
  workspaceMemoryDefaultEnabled: boolean,
): WorkspaceConfigurationValues => ({
  defaultMode: "machdoch",
  effectiveMode: "machdoch",
  defaultReasoning: "default",
  effectiveReasoning: "default",
  defaultReasoningExecutionMode: "standard",
  effectiveReasoningExecutionMode: "standard",
  defaultContextWindow: "default",
  effectiveContextWindow: "default",
  workspaceMemoryOverride: null,
  workspaceMemoryEnabled: workspaceMemoryDefaultEnabled,
});

export const WorkspaceConfigurationSettings = ({
  workspaceRoot,
  workspaceLabel,
  workspaceMemoryDefaultEnabled,
  onBusyChange,
  onSaved,
}: WorkspaceConfigurationSettingsProps): JSX.Element => {
  const [values, setValues] = useState<WorkspaceConfigurationValues | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SettingsStatusMessage | null>(null);
  const requestIdRef = useRef(0);
  const workspaceRootRef = useRef(workspaceRoot);
  const valuesRef = useRef(values);
  workspaceRootRef.current = workspaceRoot;
  valuesRef.current = values;

  const loadSnapshot = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setMessage(null);

    try {
      const nextSnapshot = await loadWorkspaceRuntimeSnapshot(workspaceRoot);

      if (
        requestIdRef.current !== requestId ||
        workspaceRootRef.current !== workspaceRoot
      ) {
        return;
      }

      if (nextSnapshot) {
        const nextValues = createWorkspaceConfigurationValues(nextSnapshot);
        valuesRef.current = nextValues;
        setValues(nextValues);
      } else if (!isTauri()) {
        const nextValues = createFallbackWorkspaceConfigurationValues(
          workspaceMemoryDefaultEnabled,
        );
        valuesRef.current = nextValues;
        setValues(nextValues);
      } else {
        setMessage({
          tone: "error",
          text: "Workspace settings could not be loaded.",
        });
      }
    } catch (error) {
      if (
        requestIdRef.current === requestId &&
        workspaceRootRef.current === workspaceRoot
      ) {
        valuesRef.current = null;
        setValues(null);
        setMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Workspace settings could not be loaded.",
        });
      }
    } finally {
      if (
        requestIdRef.current === requestId &&
        workspaceRootRef.current === workspaceRoot
      ) {
        setLoading(false);
      }
    }
  }, [workspaceMemoryDefaultEnabled, workspaceRoot]);

  useEffect(() => {
    valuesRef.current = null;
    setValues(null);
    setSaving(false);
    void loadSnapshot();

    return () => {
      requestIdRef.current += 1;
    };
  }, [loadSnapshot]);

  useEffect(() => {
    onBusyChange?.(saving);
  }, [onBusyChange, saving]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const saveSetting = useCallback(
    async (
      save: () => Promise<unknown>,
      updateValues: (
        current: WorkspaceConfigurationValues,
      ) => WorkspaceConfigurationValues,
      successMessage: string,
      failureMessage: string,
    ): Promise<void> => {
      const root = workspaceRoot;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setSaving(true);
      setMessage(null);

      try {
        await save();
        await onSaved?.(root);
        const nextSnapshot = await loadWorkspaceRuntimeSnapshot(root);

        if (
          requestIdRef.current !== requestId ||
          workspaceRootRef.current !== root
        ) {
          return;
        }

        const currentValues =
          valuesRef.current ??
          createFallbackWorkspaceConfigurationValues(
            workspaceMemoryDefaultEnabled,
          );
        const nextValues = nextSnapshot
          ? createWorkspaceConfigurationValues(nextSnapshot)
          : updateValues(currentValues);
        valuesRef.current = nextValues;
        setValues(nextValues);

        if (
          requestIdRef.current === requestId &&
          workspaceRootRef.current === root
        ) {
          setMessage({ tone: "success", text: successMessage });
        }
      } catch (error) {
        if (
          requestIdRef.current === requestId &&
          workspaceRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : failureMessage,
          });
        }
      } finally {
        if (
          requestIdRef.current === requestId &&
          workspaceRootRef.current === root
        ) {
          setSaving(false);
        }
      }
    },
    [onSaved, workspaceMemoryDefaultEnabled, workspaceRoot],
  );

  if (!values) {
    return (
      <section className="grid min-h-40 place-items-center rounded-xl border border-slate-800 bg-slate-900/20 p-4">
        {loading ? (
          <LoaderCircle className="size-5 animate-spin text-slate-500" />
        ) : (
          <div className="grid justify-items-center gap-3">
            {message ? (
              <p role="alert" className="text-sm text-red-300">
                {message.text}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadSnapshot()}
            >
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <WorkspaceSettingsPanel
      setup={{
        workspaceRoot,
        workspaceLabel,
        ...values,
        workspaceMemoryDefaultEnabled,
        saving,
        message,
        onDefaultModeChange: async (mode) => {
          await saveSetting(
            () => saveWorkspaceDefaultMode(workspaceRoot, mode),
            (current) => ({
              ...current,
              defaultMode: mode,
              effectiveMode: isTauri() ? current.effectiveMode : mode,
            }),
            "Workspace default mode saved.",
            "Workspace default mode could not be updated.",
          );
        },
        onWorkspaceMemoryOverrideChange: async (enabled) => {
          await saveSetting(
            () => saveWorkspaceMemoryOverride(workspaceRoot, enabled),
            (current) => ({
              ...current,
              workspaceMemoryOverride: enabled,
              workspaceMemoryEnabled: enabled ?? workspaceMemoryDefaultEnabled,
            }),
            "Workspace memory setting saved.",
            "Workspace memory could not be updated.",
          );
        },
        onReasoningModeChange: async (reasoning: ReasoningMode) => {
          await saveSetting(
            () => saveWorkspaceReasoningMode(workspaceRoot, reasoning),
            (current) => ({
              ...current,
              defaultReasoning: reasoning,
              effectiveReasoning: isTauri()
                ? current.effectiveReasoning
                : reasoning,
            }),
            "Workspace reasoning saved.",
            "Workspace reasoning mode could not be updated.",
          );
        },
        onReasoningExecutionModeChange: async (
          reasoningMode: ReasoningExecutionMode,
        ) => {
          await saveSetting(
            () =>
              saveWorkspaceReasoningExecutionMode(workspaceRoot, reasoningMode),
            (current) => ({
              ...current,
              defaultReasoningExecutionMode: reasoningMode,
              effectiveReasoningExecutionMode: isTauri()
                ? current.effectiveReasoningExecutionMode
                : reasoningMode,
            }),
            "Workspace reasoning mode saved.",
            "Workspace reasoning mode could not be updated.",
          );
        },
        onContextWindowChange: async (contextWindow: ContextWindow) => {
          await saveSetting(
            () => saveWorkspaceContextWindow(workspaceRoot, contextWindow),
            (current) => ({
              ...current,
              defaultContextWindow: contextWindow,
              effectiveContextWindow: isTauri()
                ? current.effectiveContextWindow
                : contextWindow,
            }),
            "Workspace context window saved.",
            "Workspace context window could not be updated.",
          );
        },
      }}
    />
  );
};
