import type {
  WorkspaceChangeEvent,
  WorkspaceChangeEvents,
} from "@machdoch/fleet-protocol/workspace-contract";

export type WorkspaceChangeListener = (event: WorkspaceChangeEvent) => void;

export interface WorkspaceChangeTransport {
  open: (
    workspaceRoot: string,
    onEvents: (events: WorkspaceChangeEvents) => void,
  ) => Promise<() => void>;
}

interface FeedWorkspace {
  workspaceRoot: string;
  listeners: Set<WorkspaceChangeListener>;
  lastSequence: number;
  close: Promise<(() => void) | null> | null;
  watching: boolean;
}

export interface WorkspaceChangeFeed {
  subscribe: (
    workspaceRoot: string,
    listener: WorkspaceChangeListener,
  ) => () => void;
  isWatching: (workspaceRoot: string) => boolean;
}

export const createWorkspaceChangeFeed = ({
  transport,
  keyOf,
  onError = (error) => console.error("Workspace watcher failed", error),
}: {
  transport: WorkspaceChangeTransport;
  keyOf: (workspaceRoot: string) => string;
  onError?: (error: unknown) => void;
}): WorkspaceChangeFeed => {
  const workspaces = new Map<string, FeedWorkspace>();

  const deliver = (workspace: FeedWorkspace, batch: WorkspaceChangeEvents) => {
    workspace.watching = batch.watching;
    for (const event of batch.events) {
      if (event.sequence <= workspace.lastSequence) continue;
      workspace.lastSequence = event.sequence;
      for (const listener of [...workspace.listeners]) listener(event);
    }
    workspace.lastSequence = Math.max(workspace.lastSequence, batch.cursor);
  };

  const open = (workspace: FeedWorkspace): void => {
    workspace.close = transport
      .open(workspace.workspaceRoot, (batch) => deliver(workspace, batch))
      .catch((error: unknown) => {
        workspace.watching = false;
        onError(error);
        return null;
      });
  };

  return {
    subscribe: (workspaceRoot, listener) => {
      const key = keyOf(workspaceRoot);
      let workspace = workspaces.get(key);
      if (!workspace) {
        workspace = {
          workspaceRoot,
          listeners: new Set(),
          lastSequence: 0,
          close: null,
          watching: false,
        };
        workspaces.set(key, workspace);
      }
      workspace.listeners.add(listener);
      if (!workspace.close) open(workspace);
      let subscribed = true;
      return () => {
        if (!subscribed || !workspace) return;
        subscribed = false;
        workspace.listeners.delete(listener);
        if (workspace.listeners.size > 0) return;
        workspaces.delete(key);
        const closing = workspace.close;
        workspace.close = null;
        workspace.watching = false;
        void closing?.then((close) => close?.());
      };
    },
    isWatching: (workspaceRoot) =>
      workspaces.get(keyOf(workspaceRoot))?.watching ?? false,
  };
};

export const repositoryChangeKinds = (
  event: WorkspaceChangeEvent,
  sameRepository: (repositoryRoot: string) => boolean,
): ReadonlySet<"worktree" | "index" | "refs"> =>
  new Set(
    event.repositories
      .filter((change) => sameRepository(change.repositoryRoot))
      .flatMap((change) => change.kinds),
  );

export const changedDirectories = (event: WorkspaceChangeEvent): string[] => {
  const directories = new Set<string>();
  for (const path of event.paths) {
    const separator = path.lastIndexOf("/");
    directories.add(separator < 0 ? "." : path.slice(0, separator));
  }
  return [...directories];
};
