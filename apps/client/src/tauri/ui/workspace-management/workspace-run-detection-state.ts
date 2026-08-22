import { useCallback, useSyncExternalStore } from "react";
import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunDetection,
} from "../../../shared/workspace-run.js";
import { precheckWorkspaceRunConfigurationJson } from "../runtime";
import {
  generateWorkspaceRunDetection,
  validateWorkspaceRunDetections,
} from "./workspace-run-ai";
import { createWorkspaceRootKey } from "./workspace-management-model";

export interface WorkspaceRunDetectionResult {
  document: WorkspaceRunConfigurationDocument;
  detections: WorkspaceRunDetection[];
}

export interface WorkspaceRunDetectionState {
  phase: "idle" | "detecting" | "complete" | "failed";
  revision: number;
  result: WorkspaceRunDetectionResult | null;
  error: string | null;
}

interface WorkspaceRunDetectionEntry {
  state: WorkspaceRunDetectionState;
  listeners: Set<() => void>;
  pending: Promise<void> | null;
  abandoned: boolean;
}

const EMPTY_DETECTION_STATE: WorkspaceRunDetectionState = {
  phase: "idle",
  revision: 0,
  result: null,
  error: null,
};

const detectionEntries = new Map<string, WorkspaceRunDetectionEntry>();

const normalizeWorkspaceRoot = (
  workspaceRoot: string | null | undefined,
): string | null => workspaceRoot?.trim() || null;

const getDetectionEntry = (
  workspaceRoot: string,
  create: boolean,
): WorkspaceRunDetectionEntry | null => {
  const key = createWorkspaceRootKey(workspaceRoot);
  const current = detectionEntries.get(key);
  if (current || !create) return current ?? null;

  const entry: WorkspaceRunDetectionEntry = {
    state: EMPTY_DETECTION_STATE,
    listeners: new Set(),
    pending: null,
    abandoned: false,
  };
  detectionEntries.set(key, entry);
  return entry;
};

const isCurrentDetectionEntry = (
  workspaceRoot: string,
  entry: WorkspaceRunDetectionEntry,
): boolean =>
  detectionEntries.get(createWorkspaceRootKey(workspaceRoot)) === entry;

const removeUnusedDetectionEntry = (
  workspaceRoot: string,
  entry: WorkspaceRunDetectionEntry,
): void => {
  if (entry.listeners.size > 0 || entry.pending) return;
  const key = createWorkspaceRootKey(workspaceRoot);
  if (detectionEntries.get(key) === entry) detectionEntries.delete(key);
};

const publishDetectionState = (
  entry: WorkspaceRunDetectionEntry,
  state: WorkspaceRunDetectionState,
): void => {
  entry.state = state;
  for (const listener of entry.listeners) listener();
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const getWorkspaceRunDetectionState = (
  workspaceRoot: string | null | undefined,
): WorkspaceRunDetectionState => {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) return EMPTY_DETECTION_STATE;
  return (
    getDetectionEntry(normalizedRoot, false)?.state ?? EMPTY_DETECTION_STATE
  );
};

export const subscribeWorkspaceRunDetection = (
  workspaceRoot: string | null | undefined,
  listener: () => void,
): (() => void) => {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) return () => undefined;
  const entry = getDetectionEntry(normalizedRoot, true);
  if (!entry) return () => undefined;
  entry.abandoned = false;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) entry.abandoned = true;
    removeUnusedDetectionEntry(normalizedRoot, entry);
  };
};

export const useWorkspaceRunDetectionState = (
  workspaceRoot: string | null | undefined,
): WorkspaceRunDetectionState => {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeWorkspaceRunDetection(workspaceRoot, listener),
    [workspaceRoot],
  );
  const getSnapshot = useCallback(
    () => getWorkspaceRunDetectionState(workspaceRoot),
    [workspaceRoot],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const executeWorkspaceRunDetection = async (
  workspaceRoot: string,
  entry: WorkspaceRunDetectionEntry,
  revision: number,
  previousResult: WorkspaceRunDetectionResult | null,
): Promise<void> => {
  try {
    const generated = await generateWorkspaceRunDetection(workspaceRoot);
    if (
      entry.abandoned ||
      !isCurrentDetectionEntry(workspaceRoot, entry)
    ) {
      return;
    }
    const document = await precheckWorkspaceRunConfigurationJson(
      workspaceRoot,
      generated.documentJson,
    );
    if (
      entry.abandoned ||
      !isCurrentDetectionEntry(workspaceRoot, entry)
    ) {
      return;
    }
    validateWorkspaceRunDetections(document, generated.detections);
    publishDetectionState(entry, {
      phase: "complete",
      revision,
      result: { document, detections: generated.detections },
      error: null,
    });
  } catch (cause) {
    if (
      entry.abandoned ||
      !isCurrentDetectionEntry(workspaceRoot, entry)
    ) {
      return;
    }
    publishDetectionState(entry, {
      phase: "failed",
      revision,
      result: previousResult,
      error: errorMessage(cause),
    });
  }
};

export const startWorkspaceRunDetection = (
  workspaceRoot: string,
): Promise<void> => {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) return Promise.resolve();
  const entry = getDetectionEntry(normalizedRoot, true);
  if (!entry) return Promise.resolve();
  if (entry.pending) return entry.pending;

  const revision = entry.state.revision + 1;
  const previousResult = entry.state.result;
  publishDetectionState(entry, {
    phase: "detecting",
    revision,
    result: previousResult,
    error: null,
  });

  const operation = executeWorkspaceRunDetection(
    normalizedRoot,
    entry,
    revision,
    previousResult,
  );
  entry.pending = operation;
  const finalize = (): void => {
    if (entry.pending === operation) {
      entry.pending = null;
      removeUnusedDetectionEntry(normalizedRoot, entry);
    }
  };
  void operation.then(finalize, finalize);
  return operation;
};

export const clearWorkspaceRunDetection = (
  workspaceRoot: string | null | undefined,
): void => {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) return;
  const entry = getDetectionEntry(normalizedRoot, false);
  if (!entry || entry.state.phase === "detecting") return;
  publishDetectionState(entry, {
    ...EMPTY_DETECTION_STATE,
    revision: entry.state.revision + 1,
  });
  removeUnusedDetectionEntry(normalizedRoot, entry);
};
