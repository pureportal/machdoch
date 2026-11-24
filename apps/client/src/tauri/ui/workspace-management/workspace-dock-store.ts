import { useSyncExternalStore } from "react";
import {
  normalizeWorkspaceDockLayout,
  type WorkspaceDockLayout,
} from "./workspace-dock-layout";
import { createWorkspaceRootKey } from "./workspace-management-model";
import {
  readTerminalCommandHistory,
  readTerminalLayout,
  readTerminalScrollback,
  rememberTerminalCommand,
  writeTerminalCommandHistory,
  writeTerminalLayout,
  writeTerminalScrollback,
  type TerminalLayout,
} from "./workspace-terminal-layout";

export interface WorkspaceFileRequest {
  id: number;
  path: string;
  line?: number;
}

export interface WorkspaceDockState {
  layout: WorkspaceDockLayout;
  terminal: TerminalLayout;
  commandHistory: readonly string[];
  fileRequest: WorkspaceFileRequest | null;
  quickOpenRequested: boolean;
}

const DOCK_PREFIX = "machdoch.workspace-dock:";

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const readLayout = (key: string): WorkspaceDockLayout => {
  try {
    const raw = storage()?.getItem(`${DOCK_PREFIX}${key}`);
    return normalizeWorkspaceDockLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeWorkspaceDockLayout(null);
  }
};

const writeLayout = (key: string, layout: WorkspaceDockLayout): void => {
  try {
    storage()?.setItem(`${DOCK_PREFIX}${key}`, JSON.stringify(layout));
  } catch (error) {
    console.error("Could not save the workspace layout", error);
  }
};

const states = new Map<string, WorkspaceDockState>();
const listeners = new Set<() => void>();
let requestId = 0;

const stateFor = (key: string): WorkspaceDockState => {
  let state = states.get(key);
  if (!state) {
    state = {
      layout: readLayout(key),
      terminal: readTerminalLayout(storage(), key),
      commandHistory: readTerminalCommandHistory(storage(), key),
      fileRequest: null,
      quickOpenRequested: false,
    };
    states.set(key, state);
  }
  return state;
};

const update = (
  workspaceRoot: string,
  change: (state: WorkspaceDockState) => WorkspaceDockState,
): void => {
  const key = createWorkspaceRootKey(workspaceRoot);
  const previous = stateFor(key);
  const next = change(previous);
  if (next === previous) return;
  states.set(key, next);
  if (next.layout !== previous.layout) writeLayout(key, next.layout);
  if (next.terminal !== previous.terminal) {
    writeTerminalLayout(storage(), key, next.terminal);
  }
  if (next.commandHistory !== previous.commandHistory) {
    writeTerminalCommandHistory(storage(), key, next.commandHistory);
  }
  for (const listener of [...listeners]) listener();
};

const handleStorage = (event: StorageEvent): void => {
  if (!event.key?.startsWith(DOCK_PREFIX)) return;
  const key = event.key.slice(DOCK_PREFIX.length);
  const state = states.get(key);
  if (!state) return;
  states.set(key, { ...state, layout: readLayout(key) });
  for (const listener of [...listeners]) listener();
};

export const workspaceDockStore = {
  get: (workspaceRoot: string): WorkspaceDockState =>
    stateFor(createWorkspaceRootKey(workspaceRoot)),
  updateLayout: (
    workspaceRoot: string,
    change: (layout: WorkspaceDockLayout) => WorkspaceDockLayout,
  ): void =>
    update(workspaceRoot, (state) => {
      const layout = change(state.layout);
      return layout === state.layout ? state : { ...state, layout };
    }),
  updateTerminal: (
    workspaceRoot: string,
    change: (terminal: TerminalLayout) => TerminalLayout,
  ): void =>
    update(workspaceRoot, (state) => {
      const terminal = change(state.terminal);
      return terminal === state.terminal ? state : { ...state, terminal };
    }),
  openFile: (workspaceRoot: string, path: string, line?: number): void =>
    update(workspaceRoot, (state) => ({
      ...state,
      layout: { ...state.layout, filesOpen: true, filesView: "explorer" },
      fileRequest: { id: ++requestId, path, ...(line ? { line } : {}) },
    })),
  rememberCommand: (workspaceRoot: string, command: string): void =>
    update(workspaceRoot, (state) => {
      const commandHistory = rememberTerminalCommand(
        state.commandHistory,
        command,
      );
      return commandHistory[0] === state.commandHistory[0] &&
        commandHistory.length === state.commandHistory.length
        ? state
        : { ...state, commandHistory };
    }),
  readTerminalHistory: (workspaceRoot: string, tabId: string): string | null =>
    readTerminalScrollback(
      storage(),
      createWorkspaceRootKey(workspaceRoot),
      tabId,
    ),
  writeTerminalHistory: (
    workspaceRoot: string,
    tabId: string,
    serialized: string | null,
  ): void =>
    writeTerminalScrollback(
      storage(),
      createWorkspaceRootKey(workspaceRoot),
      tabId,
      serialized,
    ),
  takeFileRequest: (workspaceRoot: string): WorkspaceFileRequest | null => {
    const request = workspaceDockStore.get(workspaceRoot).fileRequest;
    if (request)
      update(workspaceRoot, (state) => ({ ...state, fileRequest: null }));
    return request;
  },
  requestQuickOpen: (workspaceRoot: string): void =>
    update(workspaceRoot, (state) => ({ ...state, quickOpenRequested: true })),
  takeQuickOpenRequest: (workspaceRoot: string): boolean => {
    if (!workspaceDockStore.get(workspaceRoot).quickOpenRequested) return false;
    update(workspaceRoot, (state) => ({ ...state, quickOpenRequested: false }));
    return true;
  },
  subscribe: (listener: () => void): (() => void) => {
    if (listeners.size === 0) window.addEventListener("storage", handleStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        window.removeEventListener("storage", handleStorage);
      }
    };
  },
};

export const useWorkspaceDock = (
  workspaceRoot: string | null,
): WorkspaceDockState | null =>
  useSyncExternalStore(workspaceDockStore.subscribe, () =>
    workspaceRoot ? workspaceDockStore.get(workspaceRoot) : null,
  );
