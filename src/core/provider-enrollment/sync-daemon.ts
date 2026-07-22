import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import { getUserConfigPath } from "../env.js";
import { loadProviderEnrollmentConfig } from "./config.js";
import {
  getProviderEnrollmentStateDirectory,
  getProviderSyncWorkspaceRegistryPath,
  loadRegisteredProviderSyncWorkspaces,
  reconcileProviderSync,
} from "./sync-coordinator.js";

const DAEMON_PID_FILE_NAME = "daemon.json";
const DAEMON_DIAGNOSTIC_FILE_NAME = "daemon-diagnostic.json";
const REFRESH_REQUEST_FILE_NAME = "refresh.request";

interface DaemonRecord {
  pid: number;
  workspaceRoot: string;
  startedAt: string;
  token?: string;
}

export interface ProviderSyncDaemonDiagnostic {
  schemaVersion: 1;
  pid: number;
  workspaceRoot: string;
  runStartedAt: string;
  runCompletedAt: string;
  outcome: "success" | "error";
  error?: string;
}

const getDaemonPath = (): string => join(
  getProviderEnrollmentStateDirectory(),
  DAEMON_PID_FILE_NAME,
);

export const getProviderSyncRefreshRequestPath = (): string => join(
  getProviderEnrollmentStateDirectory(),
  REFRESH_REQUEST_FILE_NAME,
);

export const getProviderSyncDaemonDiagnosticPath = (): string => join(
  getProviderEnrollmentStateDirectory(),
  DAEMON_DIAGNOSTIC_FILE_NAME,
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
      return {
        pid: parsed.pid,
        workspaceRoot: parsed.workspaceRoot,
        startedAt: parsed.startedAt,
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
    }
  } catch {
    // Missing and malformed stale records are treated as absent.
  }
  return undefined;
};

export const loadProviderSyncDaemonDiagnostic = async (
): Promise<ProviderSyncDaemonDiagnostic | undefined> => {
  try {
    const parsed = JSON.parse(
      await readFile(getProviderSyncDaemonDiagnosticPath(), "utf8"),
    ) as Partial<ProviderSyncDaemonDiagnostic>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.pid === "number" &&
      typeof parsed.workspaceRoot === "string" &&
      typeof parsed.runStartedAt === "string" &&
      typeof parsed.runCompletedAt === "string" &&
      (parsed.outcome === "success" || parsed.outcome === "error")
    ) {
      return {
        schemaVersion: 1,
        pid: parsed.pid,
        workspaceRoot: parsed.workspaceRoot,
        runStartedAt: parsed.runStartedAt,
        runCompletedAt: parsed.runCompletedAt,
        outcome: parsed.outcome,
        ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      };
    }
  } catch {
    // Missing or malformed diagnostics are reported as unavailable.
  }
  return undefined;
};

export const getProviderSyncDaemonPid = async (): Promise<number | undefined> => {
  const record = await loadDaemonRecord();
  if (!record) return undefined;
  if (isProcessAlive(record.pid)) return record.pid;
  // Leave stale-record removal to acquireDaemon(), which performs the
  // check-and-remove while holding the daemon election lock. Removing here
  // could race with a newly elected daemon and unlink its live record.
  return undefined;
};

const acquireDaemon = async (workspaceRoot: string): Promise<() => Promise<void>> => {
  const path = getDaemonPath();
  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await withCooperativeFileLock(path, async () => {
    const existing = await loadDaemonRecord();
    if (existing && isProcessAlive(existing.pid)) {
      throw new Error(`Provider sync daemon is already running with PID ${existing.pid}.`);
    }
    await rm(path, { force: true });
    const handle = await open(path, "wx", 0o600);
    let recorded = false;
    try {
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          workspaceRoot,
          startedAt: new Date().toISOString(),
          token,
        } satisfies DaemonRecord, null, 2)}\n`,
      );
      recorded = true;
    } finally {
      await handle.close();
      if (!recorded) await rm(path, { force: true }).catch(() => undefined);
    }
  }, {
    ownerDescription: "provider-sync daemon single-instance election",
  });
  return async (): Promise<void> => {
    const current = await loadDaemonRecord();
    if (current?.pid === process.pid && current.token === token) {
      await rm(path, { force: true });
    }
  };
};

const normalizeWatchedPath = (path: string): string => {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .toLocaleLowerCase();
};

const isPathOrChild = (path: string, root: string): boolean => {
  return path === root || path.startsWith(`${root}/`);
};

export const isProviderSyncWorkspaceWatchPath = (path: string): boolean => {
  const normalized = normalizeWatchedPath(path);
  return normalized === ".env" ||
    normalized === "agents.md" ||
    normalized === ".machdoch" ||
    normalized === ".machdoch/instructions.md" ||
    isPathOrChild(normalized, ".machdoch/instructions") ||
    isPathOrChild(normalized, ".machdoch/mcp") ||
    normalized === ".github" ||
    normalized === ".github/copilot-instructions.md" ||
    isPathOrChild(normalized, ".github/instructions");
};

export const isProviderSyncUserWatchPath = (path: string): boolean => {
  const normalized = normalizeWatchedPath(path);
  return normalized === "user-config.json" ||
    normalized === "instructions.md" ||
    normalized === "mcp.json" ||
    normalized === "mcp-discovery-cache.json" ||
    isPathOrChild(normalized, "instructions");
};

const createWorkspaceWatchers = (
  workspaceRoot: string,
  onChange: () => void,
): FSWatcher[] => {
  const roots = process.platform === "linux"
    ? [...new Set([
        workspaceRoot,
        join(workspaceRoot, ".machdoch"),
        join(workspaceRoot, ".machdoch", "instructions"),
        join(workspaceRoot, ".machdoch", "mcp"),
        join(workspaceRoot, ".github"),
        join(workspaceRoot, ".github", "instructions"),
      ])]
    : [workspaceRoot];

  const watchers: FSWatcher[] = [];
  for (const root of roots) {
    try {
      const watcher = watch(
        root,
        { recursive: process.platform !== "linux" },
        (_eventType, filename) => {
          if (!filename) return onChange();
          const changedPath = relative(
            workspaceRoot,
            join(root, filename.toString()),
          );
          if (isProviderSyncWorkspaceWatchPath(changedPath)) onChange();
        },
      );
      watchers.push(watcher);
    } catch {
      // Periodic full scans cover missing or unsupported watcher roots.
    }
  }
  return watchers;
};

const createSharedWatchers = (onChange: () => void): FSWatcher[] => {
  const userConfigRoot = dirname(getUserConfigPath());
  const stateRoot = getProviderEnrollmentStateDirectory();
  const userRoots = process.platform === "linux"
    ? [userConfigRoot, join(userConfigRoot, "instructions")]
    : [userConfigRoot];
  const watchers: FSWatcher[] = [];

  for (const root of userRoots) {
    try {
      watchers.push(watch(
        root,
        { recursive: process.platform !== "linux" },
        (_eventType, filename) => {
          if (!filename) return onChange();
          const changedPath = relative(
            userConfigRoot,
            join(root, filename.toString()),
          );
          if (isProviderSyncUserWatchPath(changedPath)) onChange();
        },
      ));
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
  options: { signal?: AbortSignal } = {},
): Promise<void> => {
  const release = await acquireDaemon(workspaceRoot);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;
  let watchers: FSWatcher[] = [];
  let fullScan: ReturnType<typeof setInterval> | undefined;

  try {
    let config = await loadProviderEnrollmentConfig();

    const refreshWatchers = (workspaceRoots: readonly string[]): void => {
      for (const watcher of watchers) watcher.close();
      watchers = config.persistentSync.watch
        ? [
            ...workspaceRoots.flatMap((root) =>
              createWorkspaceWatchers(root, schedule)
            ),
            ...createSharedWatchers(schedule),
          ]
        : [];
    };

    const reconcile = async (): Promise<void> => {
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      const runStartedAt = new Date().toISOString();
      try {
        config = await loadProviderEnrollmentConfig();
        const workspaceRoots = await loadRegisteredProviderSyncWorkspaces(workspaceRoot);
        for (const registeredWorkspaceRoot of workspaceRoots) {
          await reconcileProviderSync(registeredWorkspaceRoot);
        }
        refreshWatchers(
          await loadRegisteredProviderSyncWorkspaces(workspaceRoot),
        );
        await rm(getProviderSyncRefreshRequestPath(), { force: true });
        await writeJsonAtomically(getProviderSyncDaemonDiagnosticPath(), {
          schemaVersion: 1,
          pid: process.pid,
          workspaceRoot,
          runStartedAt,
          runCompletedAt: new Date().toISOString(),
          outcome: "success",
        } satisfies ProviderSyncDaemonDiagnostic);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeJsonAtomically(getProviderSyncDaemonDiagnosticPath(), {
          schemaVersion: 1,
          pid: process.pid,
          workspaceRoot,
          runStartedAt,
          runCompletedAt: new Date().toISOString(),
          outcome: "error",
          error: message.slice(0, 4_000),
        } satisfies ProviderSyncDaemonDiagnostic).catch((diagnosticError: unknown) => {
          console.error(
            `machdoch provider-sync: Failed to persist daemon diagnostics: ${
              diagnosticError instanceof Error
                ? diagnosticError.message
                : String(diagnosticError)
            }`,
          );
        });
        console.error(`machdoch provider-sync: ${message}`);
      } finally {
        running = false;
        if (rerun) {
          rerun = false;
          void reconcile();
        }
      }
    };

    function schedule(): void {
      // Coalesce changes that arrive during reconciliation into one follow-up
      // pass. The narrowed input-only watchers prevent unrelated workspace
      // churn from feeding the daemon, while this preserves a refresh request
      // or genuine source edit that races with an in-flight pass.
      if (running) {
        rerun = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reconcile(), config.persistentSync.debounceMs);
      timer.unref?.();
    }

    await reconcile();
    fullScan = setInterval(
      () => void reconcile(),
      config.persistentSync.fullRescanIntervalMs,
    );

    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        options.signal?.removeEventListener("abort", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (fullScan) clearInterval(fullScan);
    for (const watcher of watchers) watcher.close();
    await release();
  }
};
