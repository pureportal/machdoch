import { createHash, randomUUID } from "node:crypto";
import { realpathSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import { getUserConfigPath } from "../env.js";
import { loadProviderEnrollmentConfig } from "./config.js";
import { resolveMachdochCliLaunch } from "./machdoch-cli-launch.js";
import {
  getProviderEnrollmentStateDirectory,
  getProviderSyncTargetDiscoveryIdentity,
  getProviderSyncWorkspaceRegistryPath,
  loadRegisteredProviderSyncWorkspaces,
  reconcileProviderSync,
} from "./sync-coordinator.js";

const DAEMON_PID_FILE_NAME = "daemon.json";
const DAEMON_STOP_REQUEST_FILE_NAME = "stop.request.json";
const DAEMON_DIAGNOSTIC_FILE_NAME = "daemon-diagnostic.json";
const REFRESH_REQUEST_FILE_NAME = "refresh.request";
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const DAEMON_STOP_POLL_MS = 50;
const DAEMON_CONTROL_POLL_MS = 250;
const DAEMON_RECORD_KEYS = new Set([
  "schemaVersion",
  "pid",
  "workspaceRoot",
  "startedAt",
  "token",
  "runtimeId",
]);
interface DaemonRecord {
  schemaVersion: 1;
  pid: number;
  workspaceRoot: string;
  startedAt: string;
  token: string;
  runtimeId: string;
}

interface DaemonStopRequest {
  schemaVersion: 1;
  pid: number;
  token: string;
  requestedAt: string;
}

export interface ProviderSyncDaemonWorkspaceResult {
  workspaceRoot: string;
  outcome: "success" | "error";
  error?: string;
}

export interface ProviderSyncDaemonDiagnostic {
  schemaVersion: 2;
  pid: number;
  runStartedAt: string;
  runCompletedAt: string;
  outcome: "success" | "error";
  workspaceResults: ProviderSyncDaemonWorkspaceResult[];
  error?: string;
}

const getDaemonPath = (): string =>
  join(getProviderEnrollmentStateDirectory(), DAEMON_PID_FILE_NAME);

const getDaemonStopRequestPath = (): string =>
  join(getProviderEnrollmentStateDirectory(), DAEMON_STOP_REQUEST_FILE_NAME);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() ? message : "Unknown provider-sync error.";
};

class InvalidDaemonRecordError extends Error {
  constructor(
    readonly path: string,
    readonly referencedPid: number | undefined,
    cause?: unknown,
  ) {
    super(
      `${path} is not a valid provider-sync daemon record.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "InvalidDaemonRecordError";
  }
}

const getReferencedDaemonPid = (value: unknown): number | undefined =>
  isRecord(value) &&
  typeof value.pid === "number" &&
  Number.isInteger(value.pid) &&
  value.pid > 0
    ? value.pid
    : undefined;

const invalidDaemonRecordError = (
  path: string,
  value: unknown,
  cause?: unknown,
): InvalidDaemonRecordError =>
  new InvalidDaemonRecordError(path, getReferencedDaemonPid(value), cause);

export const getProviderSyncRefreshRequestPath = (): string =>
  join(getProviderEnrollmentStateDirectory(), REFRESH_REQUEST_FILE_NAME);

export const getProviderSyncDaemonDiagnosticPath = (): string =>
  join(getProviderEnrollmentStateDirectory(), DAEMON_DIAGNOSTIC_FILE_NAME);

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

const normalizeRuntimePath = (path: string): string => {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
};

export const getProviderSyncDaemonRuntimeId = (): string => {
  const launch = resolveMachdochCliLaunch();
  const targetDiscovery = getProviderSyncTargetDiscoveryIdentity();
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: normalizeRuntimePath(launch.command),
        args: launch.args,
        cwd: normalizeRuntimePath(launch.cwd),
        environment: launch.environment,
        targetDiscovery: {
          userHome: normalizeRuntimePath(targetDiscovery.userHome),
          codexHome: normalizeRuntimePath(targetDiscovery.codexHome),
          claudeConfigDirectory: normalizeRuntimePath(
            targetDiscovery.claudeConfigDirectory,
          ),
          copilotHome: normalizeRuntimePath(targetDiscovery.copilotHome),
        },
      }),
    )
    .digest("hex");
};

const loadDaemonRecord = async (): Promise<DaemonRecord | undefined> => {
  const path = getDaemonPath();
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw invalidDaemonRecordError(path, undefined, error);
  }
  const recordKeys = isRecord(parsed) ? Object.keys(parsed) : [];
  const isCurrentRecord =
    isRecord(parsed) &&
    parsed.schemaVersion === 1 &&
    recordKeys.every((key) => DAEMON_RECORD_KEYS.has(key));
  if (
    !isRecord(parsed) ||
    !isCurrentRecord ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.workspaceRoot !== "string" ||
    typeof parsed.startedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.startedAt)) ||
    typeof parsed.token !== "string" ||
    parsed.token.length === 0 ||
    typeof parsed.runtimeId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.runtimeId)
  ) {
    throw invalidDaemonRecordError(path, parsed);
  }
  return {
    schemaVersion: 1,
    pid: parsed.pid,
    workspaceRoot: parsed.workspaceRoot,
    startedAt: parsed.startedAt,
    token: parsed.token,
    runtimeId: parsed.runtimeId,
  };
};

export const loadProviderSyncDaemonDiagnostic = async (): Promise<
  ProviderSyncDaemonDiagnostic | undefined
> => {
  try {
    const parsed = JSON.parse(
      await readFile(getProviderSyncDaemonDiagnosticPath(), "utf8"),
    ) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 2 ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.runStartedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.runStartedAt)) ||
      typeof parsed.runCompletedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.runCompletedAt)) ||
      (parsed.outcome !== "success" && parsed.outcome !== "error") ||
      !Array.isArray(parsed.workspaceResults) ||
      parsed.workspaceResults.length > 4_096 ||
      !parsed.workspaceResults.every(
        (result) =>
          isRecord(result) &&
          typeof result.workspaceRoot === "string" &&
          result.workspaceRoot.length > 0 &&
          result.workspaceRoot.length <= 32_768 &&
          resolve(result.workspaceRoot) === result.workspaceRoot &&
          (result.outcome === "success" || result.outcome === "error") &&
          (result.error === undefined ||
            (typeof result.error === "string" && result.error.length > 0)) &&
          (result.outcome === "error") === (result.error !== undefined),
      ) ||
      (parsed.error !== undefined &&
        (typeof parsed.error !== "string" || parsed.error.length === 0))
    ) {
      return undefined;
    }
    const workspaceResults =
      parsed.workspaceResults as ProviderSyncDaemonWorkspaceResult[];
    const hasError =
      parsed.error !== undefined ||
      workspaceResults.some((result) => result.outcome === "error");
    if ((parsed.outcome === "error") !== hasError) return undefined;
    return {
      schemaVersion: 2,
      pid: parsed.pid,
      runStartedAt: parsed.runStartedAt,
      runCompletedAt: parsed.runCompletedAt,
      outcome: parsed.outcome,
      workspaceResults,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    // Missing or malformed diagnostics are reported as unavailable.
  }
  return undefined;
};

const removeRecoverableDaemonRecord = async (
  path: string,
  state: "invalid" | "stale",
): Promise<void> => {
  try {
    await Promise.all([
      rm(path, { force: true }),
      rm(getDaemonStopRequestPath(), { force: true }),
    ]);
  } catch (error) {
    throw new Error(
      `Machdoch found a recoverable ${state} provider-sync daemon record at ${path}, but could not remove it: ${error instanceof Error ? error.message : String(error)}. Check the file permissions or remove the file, then retry.`,
      { cause: error },
    );
  }
};

const loadDaemonStopRequest = async (): Promise<
  DaemonStopRequest | undefined
> => {
  try {
    const parsed = JSON.parse(
      await readFile(getDaemonStopRequestPath(), "utf8"),
    ) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      typeof parsed.requestedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.requestedAt))
    ) {
      throw new Error(
        `${getDaemonStopRequestPath()} is not a valid provider-sync stop request.`,
      );
    }
    return {
      schemaVersion: 1,
      pid: parsed.pid,
      token: parsed.token,
      requestedAt: parsed.requestedAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const loadRecoverableDaemonRecordUnlocked = async (
  removableLivePid?: number,
): Promise<DaemonRecord | undefined> => {
  const path = getDaemonPath();
  try {
    const record = await loadDaemonRecord();
    if (!record) {
      await removeRecoverableDaemonRecord(path, "stale");
      return undefined;
    }
    if (isProcessAlive(record.pid)) return record;
    await removeRecoverableDaemonRecord(path, "stale");
    return undefined;
  } catch (error) {
    if (!(error instanceof InvalidDaemonRecordError)) throw error;
    const livePid =
      error.referencedPid !== removableLivePid &&
      error.referencedPid !== undefined &&
      isProcessAlive(error.referencedPid)
        ? error.referencedPid
        : undefined;
    if (livePid !== undefined) {
      throw new Error(
        `${path} is invalid, but persisted provider-sync state references running PID ${livePid}. Machdoch will not remove the record while that process may own synchronization. Close the provider-sync process and retry; Machdoch will remove the stale record automatically. If PID ${livePid} belongs to another application, remove the invalid daemon record and retry.`,
        { cause: error },
      );
    }
    await removeRecoverableDaemonRecord(path, "invalid");
    return undefined;
  }
};

const loadActiveDaemonRecord = async (): Promise<DaemonRecord | undefined> => {
  const path = getDaemonPath();
  return await withCooperativeFileLock(
    path,
    async () => await loadRecoverableDaemonRecordUnlocked(),
    {
      ownerDescription: "provider-sync daemon state recovery",
      recoverDeadOwnerImmediately: true,
    },
  );
};

export const getProviderSyncDaemonPid = async (): Promise<
  number | undefined
> => {
  return (await loadActiveDaemonRecord())?.pid;
};

export const getCurrentProviderSyncDaemonPid = async (): Promise<
  number | undefined
> => {
  const record = await loadActiveDaemonRecord();
  if (!record || record.runtimeId !== getProviderSyncDaemonRuntimeId()) {
    return undefined;
  }
  return record.pid;
};

const isSameDaemonRecord = (
  left: DaemonRecord | undefined,
  right: DaemonRecord,
): boolean =>
  left?.pid === right.pid &&
  left.startedAt === right.startedAt &&
  left.token === right.token;

const removeStoppedDaemonRecord = async (
  record: DaemonRecord,
): Promise<boolean> => {
  let removed = false;
  await withCooperativeFileLock(
    getDaemonPath(),
    async () => {
      const current = await loadDaemonRecord();
      if (!isSameDaemonRecord(current, record)) {
        removed = true;
        return;
      }
      if (!isProcessAlive(record.pid)) {
        await removeRecoverableDaemonRecord(getDaemonPath(), "stale");
        removed = true;
      }
    },
    {
      ownerDescription: "provider-sync stopped daemon recovery",
      recoverDeadOwnerImmediately: true,
    },
  );
  return removed;
};

const waitForDaemonRelease = async (
  record: DaemonRecord,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = await loadDaemonRecord();
      if (!isSameDaemonRecord(current, record)) return true;
      if (
        !isProcessAlive(record.pid) &&
        (await removeStoppedDaemonRecord(record))
      ) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof InvalidDaemonRecordError)) throw error;
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, DAEMON_STOP_POLL_MS);
    });
  }
  return false;
};

export const stopProviderSyncDaemon = async (
  options: {
    onlyIfRuntimeMismatch?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<boolean> => {
  const record = await loadActiveDaemonRecord();
  if (!record) return false;
  if (
    options.onlyIfRuntimeMismatch &&
    record.runtimeId === getProviderSyncDaemonRuntimeId()
  ) {
    return false;
  }
  if (record.pid === process.pid) {
    throw new Error("The provider sync daemon cannot stop its own process.");
  }

  let requested = false;
  await withCooperativeFileLock(
    getDaemonPath(),
    async () => {
      const current = await loadDaemonRecord();
      if (!isSameDaemonRecord(current, record)) return;
      await writeJsonAtomically(
        getDaemonStopRequestPath(),
        {
          schemaVersion: 1,
          pid: record.pid,
          token: record.token,
          requestedAt: new Date().toISOString(),
        } satisfies DaemonStopRequest,
        { mode: 0o600 },
      );
      requested = true;
    },
    {
      ownerDescription: "provider-sync authenticated daemon stop",
      recoverDeadOwnerImmediately: true,
    },
  );
  if (!requested) return false;

  const stopped = await waitForDaemonRelease(
    record,
    options.timeoutMs ?? DAEMON_STOP_TIMEOUT_MS,
  );
  if (!stopped) {
    throw new Error(
      `Provider sync daemon PID ${record.pid} did not acknowledge its authenticated stop request within ${
        options.timeoutMs ?? DAEMON_STOP_TIMEOUT_MS
      }ms. Close the provider-sync process, then retry.`,
    );
  }
  return true;
};

const acquireDaemon = async (
  workspaceRoot: string,
): Promise<{
  stopRequested: () => Promise<boolean>;
  release: () => Promise<void>;
}> => {
  const path = getDaemonPath();
  const token = randomUUID();
  const record = {
    schemaVersion: 1,
    pid: process.pid,
    workspaceRoot,
    startedAt: new Date().toISOString(),
    token,
    runtimeId: getProviderSyncDaemonRuntimeId(),
  } satisfies DaemonRecord;
  await mkdir(dirname(path), { recursive: true });
  await withCooperativeFileLock(
    path,
    async () => {
      const existing = await loadRecoverableDaemonRecordUnlocked();
      if (existing) {
        throw new Error(
          `Provider sync daemon is already running with PID ${existing.pid}.`,
        );
      }
      try {
        await rm(getDaemonStopRequestPath(), { force: true });
        await writeJsonAtomically(path, record, { mode: 0o600 });
      } catch (error) {
        try {
          await Promise.all([
            rm(path, { force: true }),
            rm(getDaemonStopRequestPath(), { force: true }),
          ]);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Provider sync daemon acquisition failed and its partial state could not be removed. Remove the daemon state files, then retry.",
          );
        }
        throw error;
      }
    },
    {
      ownerDescription: "provider-sync daemon single-instance election",
      recoverDeadOwnerImmediately: true,
    },
  );
  return {
    stopRequested: async (): Promise<boolean> => {
      const stopRequest = await loadDaemonStopRequest();
      return (
        stopRequest?.pid === record.pid && stopRequest.token === record.token
      );
    },
    release: async (): Promise<void> => {
      await withCooperativeFileLock(
        path,
        async () => {
          const current = await loadRecoverableDaemonRecordUnlocked(
            process.pid,
          );
          if (current?.pid === process.pid && current.token === token) {
            await Promise.all([
              rm(path, { force: true }),
              rm(getDaemonStopRequestPath(), { force: true }),
            ]);
          }
        },
        {
          ownerDescription: "provider-sync daemon release",
          recoverDeadOwnerImmediately: true,
        },
      );
    },
  };
};

const normalizeWatchedPath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
};

const isPathOrChild = (path: string, root: string): boolean => {
  return path === root || path.startsWith(`${root}/`);
};

export const isProviderSyncWorkspaceWatchPath = (path: string): boolean => {
  const normalized = normalizeWatchedPath(path);
  return (
    normalized === ".env" ||
    normalized === ".machdoch" ||
    isPathOrChild(normalized, ".machdoch/mcp")
  );
};

export const isProviderSyncUserWatchPath = (path: string): boolean => {
  const normalized = normalizeWatchedPath(path);
  return (
    normalized === "user-config.json" ||
    normalized === "mcp.json" ||
    normalized === "mcp-discovery-cache.json"
  );
};

const resolveWatcherRoot = (path: string): string => {
  if (process.platform !== "win32") return path;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

const createWorkspaceWatchers = (
  workspaceRoot: string,
  onChange: () => void,
): FSWatcher[] => {
  const watchWorkspaceRoot = resolveWatcherRoot(workspaceRoot);
  const useSeparateDirectoryWatchers =
    process.platform === "linux" || process.platform === "win32";
  const roots = useSeparateDirectoryWatchers
    ? [
        ...new Set([
          watchWorkspaceRoot,
          join(watchWorkspaceRoot, ".machdoch"),
          join(watchWorkspaceRoot, ".machdoch", "mcp"),
        ]),
      ]
    : [watchWorkspaceRoot];

  const watchers: FSWatcher[] = [];
  for (const root of roots) {
    try {
      const watcher = watch(
        root,
        { recursive: !useSeparateDirectoryWatchers },
        (_eventType, filename) => {
          if (!filename) return onChange();
          const changedPath = relative(
            watchWorkspaceRoot,
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
  const userConfigRoot = resolveWatcherRoot(dirname(getUserConfigPath()));
  const stateRoot = resolveWatcherRoot(getProviderEnrollmentStateDirectory());
  const userRoots = [userConfigRoot];
  const watchers: FSWatcher[] = [];

  for (const root of userRoots) {
    try {
      watchers.push(
        watch(root, { recursive: false }, (_eventType, filename) => {
          if (!filename) return onChange();
          const changedPath = relative(
            userConfigRoot,
            join(root, filename.toString()),
          );
          if (isProviderSyncUserWatchPath(changedPath)) onChange();
        }),
      );
    } catch {
      // Periodic full scans cover missing or unsupported watcher roots.
    }
  }

  try {
    watchers.push(
      watch(stateRoot, { recursive: false }, (_eventType, filename) => {
        const name = filename?.toString();
        if (
          name === REFRESH_REQUEST_FILE_NAME ||
          name === basename(getProviderSyncWorkspaceRegistryPath())
        ) {
          onChange();
        }
      }),
    );
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
  const daemonLease = await acquireDaemon(workspaceRoot);
  let controlTimer: ReturnType<typeof setInterval> | undefined;
  let activeControlCheck: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;
  let watchers: FSWatcher[] = [];
  let fullScan: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let activeReconcile: Promise<void> | undefined;
  let resolveDaemonStop: () => void;
  const stopped = new Promise<void>((resolveStop) => {
    resolveDaemonStop = resolveStop;
  });
  const stopDaemon = (): void => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", stopDaemon);
    process.off("SIGTERM", stopDaemon);
    options.signal?.removeEventListener("abort", stopDaemon);
    resolveDaemonStop();
  };
  process.once("SIGINT", stopDaemon);
  process.once("SIGTERM", stopDaemon);
  options.signal?.addEventListener("abort", stopDaemon, { once: true });
  if (options.signal?.aborted) stopDaemon();

  try {
    controlTimer = setInterval(() => {
      if (activeControlCheck) return;
      const pending = (async (): Promise<void> => {
        try {
          const stopRequested = await daemonLease.stopRequested();
          if (stopRequested) stopDaemon();
        } catch (error) {
          console.error(
            `machdoch provider-sync: Failed to read the authenticated daemon stop request: ${error instanceof Error ? error.message : String(error)}`,
          );
          stopDaemon();
        }
      })();
      activeControlCheck = pending;
      void pending.then(() => {
        if (activeControlCheck === pending) activeControlCheck = undefined;
      });
    }, DAEMON_CONTROL_POLL_MS);
    controlTimer.unref?.();
    let config = await loadProviderEnrollmentConfig();

    const refreshWatchers = (workspaceRoots: readonly string[]): void => {
      for (const watcher of watchers) watcher.close();
      watchers = config.persistentSync.watch
        ? [
            ...workspaceRoots.flatMap((root) =>
              createWorkspaceWatchers(root, schedule),
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
      const workspaceResults: ProviderSyncDaemonWorkspaceResult[] = [];
      try {
        config = await loadProviderEnrollmentConfig();
        const workspaceRoots =
          await loadRegisteredProviderSyncWorkspaces(workspaceRoot);
        for (const registeredWorkspaceRoot of workspaceRoots) {
          try {
            await reconcileProviderSync(registeredWorkspaceRoot);
            workspaceResults.push({
              workspaceRoot: registeredWorkspaceRoot,
              outcome: "success",
            });
          } catch (error) {
            const message = getErrorMessage(error);
            workspaceResults.push({
              workspaceRoot: registeredWorkspaceRoot,
              outcome: "error",
              error: message.slice(0, 4_000),
            });
            console.error(
              `machdoch provider-sync: Failed to reconcile ${registeredWorkspaceRoot}: ${message}`,
            );
          }
        }
        refreshWatchers(workspaceRoots);
        const outcome = workspaceResults.some(
          (result) => result.outcome === "error",
        )
          ? "error"
          : "success";
        if (outcome === "success") {
          await rm(getProviderSyncRefreshRequestPath(), { force: true });
        }
        await writeJsonAtomically(getProviderSyncDaemonDiagnosticPath(), {
          schemaVersion: 2,
          pid: process.pid,
          runStartedAt,
          runCompletedAt: new Date().toISOString(),
          outcome,
          workspaceResults,
        } satisfies ProviderSyncDaemonDiagnostic);
      } catch (error) {
        const message = getErrorMessage(error);
        await writeJsonAtomically(getProviderSyncDaemonDiagnosticPath(), {
          schemaVersion: 2,
          pid: process.pid,
          runStartedAt,
          runCompletedAt: new Date().toISOString(),
          outcome: "error",
          workspaceResults,
          error: message.slice(0, 4_000),
        } satisfies ProviderSyncDaemonDiagnostic).catch(
          (diagnosticError: unknown) => {
            console.error(
              `machdoch provider-sync: Failed to persist daemon diagnostics: ${
                diagnosticError instanceof Error
                  ? diagnosticError.message
                  : String(diagnosticError)
              }`,
            );
          },
        );
        console.error(`machdoch provider-sync: ${message}`);
      } finally {
        running = false;
        if (rerun && !stopping) {
          rerun = false;
          startReconcile();
        }
      }
    };

    function startReconcile(): void {
      if (stopping) return;
      if (running) {
        rerun = true;
        return;
      }
      const pending = reconcile();
      activeReconcile = pending;
      void pending.then(
        () => {
          if (activeReconcile === pending) activeReconcile = undefined;
        },
        () => {
          if (activeReconcile === pending) activeReconcile = undefined;
        },
      );
    }

    function schedule(): void {
      // Coalesce changes that arrive during reconciliation into one follow-up
      // pass. The narrowed input-only watchers prevent unrelated workspace
      // churn from feeding the daemon, while this preserves a refresh request
      // or genuine source edit that races with an in-flight pass.
      if (stopping) return;
      if (running) {
        rerun = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(startReconcile, config.persistentSync.debounceMs);
      timer.unref?.();
    }

    await reconcile();
    fullScan = setInterval(
      startReconcile,
      config.persistentSync.fullRescanIntervalMs,
    );

    await stopped;
  } finally {
    stopping = true;
    process.off("SIGINT", stopDaemon);
    process.off("SIGTERM", stopDaemon);
    options.signal?.removeEventListener("abort", stopDaemon);
    if (controlTimer) clearInterval(controlTimer);
    await activeControlCheck;
    await activeReconcile;
    if (timer) clearTimeout(timer);
    if (fullScan) clearInterval(fullScan);
    for (const watcher of watchers) watcher.close();
    await daemonLease.release();
  }
};
