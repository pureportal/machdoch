import type { WorkspaceChangeEvent } from "@machdoch/fleet-protocol/workspace-contract";
import { loadWorkspaceGitFingerprint } from "../runtime";
import { workspaceChangeFeed } from "./workspace-change-events";
import type { WorkspaceChangeFeed } from "./workspace-change-feed";
import { createWorkspaceRootKey } from "./workspace-management-model";

type WorkspaceGitChangeListener = (
  workspaceRoot: string,
  event?: WorkspaceChangeEvent,
) => void;

interface MonitoredWorkspace {
  workspaceRoot: string;
  watchers: number;
  fingerprint: string | undefined;
  sequence: number;
  polling: boolean;
  quietUntil: number;
  stopEvents: (() => void) | null;
}

interface WorkspaceGitChangeMonitorOptions {
  load: (workspaceRoot: string) => Promise<string>;
  keyOf: (workspaceRoot: string) => string;
  startPolling: (check: () => void) => () => void;
  changes: Pick<WorkspaceChangeFeed, "subscribe" | "isWatching">;
  now: () => number;
}

const LOCAL_ACTION_QUIET_MS = 1_200;

export interface WorkspaceGitChangeMonitor {
  watch: (workspaceRoot: string) => () => void;
  subscribe: (listener: WorkspaceGitChangeListener) => () => void;
  check: () => void;
  sync: (workspaceRoot: string) => void;
}

export const createWorkspaceGitChangeMonitor = ({
  load,
  keyOf,
  startPolling,
  changes,
  now,
}: WorkspaceGitChangeMonitorOptions): WorkspaceGitChangeMonitor => {
  const workspaces = new Map<string, MonitoredWorkspace>();
  const listeners = new Set<WorkspaceGitChangeListener>();
  let activeWatchers = 0;
  let stopPolling: (() => void) | null = null;
  let sequence = 0;

  const read = async (
    workspace: MonitoredWorkspace,
    notify: boolean,
  ): Promise<void> => {
    const started = ++sequence;
    const fingerprint = await load(workspace.workspaceRoot).catch(() => null);
    if (fingerprint === null || started < workspace.sequence) return;
    workspace.sequence = started;
    const previous = workspace.fingerprint;
    workspace.fingerprint = fingerprint;
    if (notify && previous !== undefined && previous !== fingerprint) {
      for (const listener of listeners) listener(workspace.workspaceRoot);
    }
  };

  const poll = (workspace: MonitoredWorkspace): void => {
    if (workspace.polling) return;
    workspace.polling = true;
    void read(workspace, true).finally(() => {
      workspace.polling = false;
    });
  };

  const check = (): void => {
    for (const workspace of workspaces.values()) {
      if (
        workspace.watchers > 0 &&
        !changes.isWatching(workspace.workspaceRoot)
      ) {
        poll(workspace);
      }
    }
  };

  const receive = (
    workspace: MonitoredWorkspace,
    event: WorkspaceChangeEvent,
  ): void => {
    if (event.repositories.length === 0 && !event.rescan) return;
    if (now() < workspace.quietUntil) return;
    for (const listener of listeners) listener(workspace.workspaceRoot, event);
  };

  return {
    watch: (workspaceRoot) => {
      const key = keyOf(workspaceRoot);
      const workspace = workspaces.get(key) ?? {
        workspaceRoot,
        watchers: 0,
        fingerprint: undefined,
        sequence: 0,
        polling: false,
        quietUntil: 0,
        stopEvents: null,
      };
      workspaces.set(key, workspace);
      workspace.workspaceRoot = workspaceRoot;
      workspace.watchers += 1;
      activeWatchers += 1;
      if (workspace.watchers === 1) {
        poll(workspace);
        workspace.stopEvents = changes.subscribe(workspaceRoot, (event) =>
          receive(workspace, event),
        );
      }
      stopPolling ??= startPolling(check);
      let watching = true;
      return () => {
        if (!watching) return;
        watching = false;
        workspace.watchers -= 1;
        activeWatchers -= 1;
        if (workspace.watchers === 0) {
          workspace.stopEvents?.();
          workspace.stopEvents = null;
        }
        if (activeWatchers === 0) {
          stopPolling?.();
          stopPolling = null;
        }
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    sync: (workspaceRoot) => {
      const workspace = workspaces.get(keyOf(workspaceRoot));
      if (!workspace) return;
      workspace.quietUntil = now() + LOCAL_ACTION_QUIET_MS;
      void read(workspace, false);
    },
  };
};

const POLL_INTERVAL_MS = 3_000;

export const workspaceGitChangeMonitor = createWorkspaceGitChangeMonitor({
  load: loadWorkspaceGitFingerprint,
  keyOf: createWorkspaceRootKey,
  changes: workspaceChangeFeed,
  now: () => Date.now(),
  startPolling: (check) => {
    const checkVisible = (): void => {
      if (document.visibilityState === "visible") check();
    };
    const timer = window.setInterval(checkVisible, POLL_INTERVAL_MS);
    window.addEventListener("focus", checkVisible);
    document.addEventListener("visibilitychange", checkVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", checkVisible);
      document.removeEventListener("visibilitychange", checkVisible);
    };
  },
});
