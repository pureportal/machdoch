import {
  createWorkspaceChangeFeed,
  type WorkspaceChangeTransport,
} from "./workspace-change-feed";
import { createWorkspaceRootKey } from "./workspace-management-model";
import {
  readWorkspaceChanges,
  unwatchWorkspaceChanges,
  watchWorkspaceChanges,
} from "./workspace-tools-runtime";
import { getRemoteWorkspacePlatform } from "./workspace-platform";

const LOCAL_READ_INTERVAL_MS = 200;
const REMOTE_READ_INTERVAL_MS = 1_500;
const HIDDEN_READ_INTERVAL_MS = 5_000;

const readInterval = (): number =>
  document.visibilityState !== "visible"
    ? HIDDEN_READ_INTERVAL_MS
    : getRemoteWorkspacePlatform()
      ? REMOTE_READ_INTERVAL_MS
      : LOCAL_READ_INTERVAL_MS;

const pollingTransport: WorkspaceChangeTransport = {
  open: async (workspaceRoot, onEvents) => {
    let cursor = await watchWorkspaceChanges(workspaceRoot);
    let closed = false;
    let timer: number | undefined;
    const read = async (): Promise<void> => {
      timer = undefined;
      if (closed) return;
      try {
        const batch = await readWorkspaceChanges(workspaceRoot, cursor);
        cursor = batch.cursor;
        if (!closed) onEvents(batch);
      } catch (error) {
        console.error("Reading workspace changes failed", error);
      }
      if (!closed) timer = window.setTimeout(read, readInterval());
    };
    const readNow = (): void => {
      if (timer === undefined || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void read();
    };
    document.addEventListener("visibilitychange", readNow);
    void read();
    return () => {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", readNow);
      void unwatchWorkspaceChanges(workspaceRoot).catch((error: unknown) =>
        console.error("Stopping the workspace watcher failed", error),
      );
    };
  },
};

export const workspaceChangeFeed = createWorkspaceChangeFeed({
  transport: pollingTransport,
  keyOf: createWorkspaceRootKey,
});
