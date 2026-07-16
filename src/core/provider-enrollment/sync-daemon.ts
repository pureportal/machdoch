import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getUserConfigPath } from "../env.js";
import { loadProviderEnrollmentConfig } from "./config.js";
import {
  getProviderEnrollmentStateDirectory,
  getProviderSyncWorkspaceRegistryPath,
  loadRegisteredProviderSyncWorkspaces,
  reconcileProviderSync,
} from "./sync-coordinator.js";

const DAEMON_PID_FILE_NAME = "daemon.json";
const REFRESH_REQUEST_FILE_NAME = "refresh.request";

interface DaemonRecord {
  pid: number;
  workspaceRoot: string;
  startedAt: string;
}

const getDaemonPath = (): string => join(
  getProviderEnrollmentStateDirectory(),
  DAEMON_PID_FILE_NAME,
);

export const getProviderSyncRefreshRequestPath = (): string => join(
  getProviderEnrollmentStateDirectory(),
  REFRESH_REQUEST_FILE_NAME,
);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
};

const loadDaemonRecord = async (): Promise<DaemonRecord | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(getDaemonPath(), "utf8")) as Partial<DaemonRecord>;
    if (
      typeof parsed.pid === "number" &&
      parsed.pid > 0 &&
      typeof parsed.workspaceRoot === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as DaemonRecord;
    }
  } catch {
    // Missing and malformed stale records are treated as absent.
  }
  return undefined;
};

export const getProviderSyncDaemonPid = async (): Promise<number | undefined> => {
  const record = await loadDaemonRecord();
  if (!record) return undefined;
  if (isProcessAlive(record.pid)) return record.pid;
  await rm(getDaemonPath(), { force: true }).catch(() => undefined);
  return undefined;
};

const acquireDaemon = async (workspaceRoot: string): Promise<() => Promise<void>> => {
  const path = getDaemonPath();
  await mkdir(dirname(path), { recursive: true });
  const existing = await loadDaemonRecord();
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(`Provider sync daemon is already running with PID ${existing.pid}.`);
  }
  await rm(path, { force: true });
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(
    `${JSON.stringify({
      pid: process.pid,
      workspaceRoot,
      startedAt: new Date().toISOString(),
    } satisfies DaemonRecord, null, 2)}\n`,
  );
  await handle.close();
  return async (): Promise<void> => {
    const current = await loadDaemonRecord();
    if (current?.pid === process.pid) {
      await rm(path, { force: true });
    }
  };
};

const createWatchers = (
  workspaceRoot: string,
  onChange: () => void,
): FSWatcher[] => {
  const userConfigRoot = dirname(getUserConfigPath());
  const stateRoot = getProviderEnrollmentStateDirectory();
  const stateDirectoryName = basename(stateRoot);
  const roots = [...new Set([
    join(workspaceRoot, ".machdoch"),
    join(workspaceRoot, ".github"),
    workspaceRoot,
    userConfigRoot,
  ])];

  // stat() is asynchronous, so only attempt existing roots synchronously via
  // watch's guarded construction. A missing optional directory is harmless.
  const watchers: FSWatcher[] = [];
  for (const root of roots) {
    try {
      const watcher = watch(
        root,
        { recursive: process.platform !== "linux" },
        (_eventType, filename) => {
          const changedPath = filename?.toString().replaceAll("\\", "/") ?? "";
          if (
            root === userConfigRoot &&
            changedPath.startsWith(`${stateDirectoryName}/`)
          ) {
            return;
          }
          onChange();
        },
      );
      watchers.push(watcher);
    } catch {
      // Periodic full scans cover missing or unsupported watcher roots.
    }
  }
  try {
    watchers.push(watch(stateRoot, { recursive: false }, (_eventType, filename) => {
      const name = filename?.toString();
      if (
        name === REFRESH_REQUEST_FILE_NAME ||
        name === basename(getProviderSyncWorkspaceRegistryPath())
      ) {
        onChange();
      }
    }));
  } catch {
    // The periodic full scan remains the recovery path.
  }
  return watchers;
};

export const requestProviderSyncRefresh = async (): Promise<void> => {
  const path = getProviderSyncRefreshRequestPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${Date.now()}\n`, "utf8");
};

export const runProviderSyncDaemon = async (
  workspaceRoot: string,
): Promise<void> => {
  const release = await acquireDaemon(workspaceRoot);
  const config = await loadProviderEnrollmentConfig();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;
  let watchers: FSWatcher[] = [];
  let watchedWorkspaceSignature = "";

  const refreshWatchers = (workspaceRoots: readonly string[]): void => {
    const signature = workspaceRoots.join("\u0000");
    if (signature === watchedWorkspaceSignature) return;
    for (const watcher of watchers) watcher.close();
    watchers = config.persistentSync.watch
      ? workspaceRoots.flatMap((root) => createWatchers(root, schedule))
      : [];
    watchedWorkspaceSignature = signature;
  };

  const reconcile = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const workspaceRoots = await loadRegisteredProviderSyncWorkspaces(workspaceRoot);
      for (const registeredWorkspaceRoot of workspaceRoots) {
        await reconcileProviderSync(registeredWorkspaceRoot);
      }
      refreshWatchers(
        await loadRegisteredProviderSyncWorkspaces(workspaceRoot),
      );
      await rm(getProviderSyncRefreshRequestPath(), { force: true });
    } catch (error) {
      console.error(
        `machdoch provider-sync: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        void reconcile();
      }
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reconcile(), config.persistentSync.debounceMs);
    timer.unref?.();
  };

  await reconcile();
  const fullScan = setInterval(
    () => void reconcile(),
    config.persistentSync.fullRescanIntervalMs,
  );

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  if (timer) clearTimeout(timer);
  clearInterval(fullScan);
  for (const watcher of watchers) watcher.close();
  await release();
};
