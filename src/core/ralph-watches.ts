import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { homedir } from "node:os";
import {
  DurableSmartScheduler,
  getUserSchedulerStatePath,
  type CreateScheduledJobInput,
  type ScheduledTriggerEventInput,
  type ScheduledTriggerEventResult,
} from "./scheduler.js";
import {
  getRalphStorageDirectory,
  getUserRalphDirectory,
  type RalphFlowScope,
} from "./ralph.js";
import { normalizeOptionalString } from "../helpers/normalize-optional-string.helper.js";

export const RALPH_WATCH_SCHEMA = "machdoch.ralphWatches" as const;
export const RALPH_WATCH_SCHEMA_VERSION = 1 as const;
export const RALPH_WATCH_FILE_NAME = "watches.json";

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_STABILITY_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_EVENTS_PER_WINDOW = 100;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const WATCH_EVENT_TYPES = ["created", "changed", "deleted", "renamed"] as const;
const DANGEROUS_PATH_PATTERN =
  /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|secrets?|credentials?)([\\/]|$)|(^|[\\/])\.env(\.|$)/iu;

const DEFAULT_EXCLUDES = [
  ".git/**",
  ".machdoch/**",
  ".next/**",
  ".turbo/**",
  "build/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "out/**",
  "target/**",
];

export type RalphWatchEventType = (typeof WATCH_EVENT_TYPES)[number];

export interface RalphWatchRoot {
  path: string;
  workspaceRoot?: string;
  include: string[];
  exclude: string[];
}

export interface RalphWatchFlowReference {
  scope: RalphFlowScope;
  id: string;
}

export interface RalphWatchPermissionProfile {
  allowedRoots: string[];
  allowCommands: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  allowMcpTools: boolean;
}

export interface RalphWatchDefinition {
  id: string;
  enabled: boolean;
  name?: string;
  flow: RalphWatchFlowReference;
  executionWorkspaceRoot: string;
  runLogScope?: RalphFlowScope;
  roots: RalphWatchRoot[];
  events: RalphWatchEventType[];
  params: Record<string, string>;
  permissions: RalphWatchPermissionProfile;
  debounceMs: number;
  stabilityMs: number;
  pollIntervalMs: number;
  cooldownMs?: number;
  maxEventsPerWindow: {
    maxEvents: number;
    windowMs: number;
  };
  maxTransitions?: number;
  concurrencyLimit: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface RalphWatchState {
  schema: typeof RALPH_WATCH_SCHEMA;
  schemaVersion: typeof RALPH_WATCH_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  watches: RalphWatchDefinition[];
}

export interface RalphWatchInput {
  id?: string;
  enabled?: boolean;
  name?: string;
  flow: Partial<RalphWatchFlowReference> & { id: string };
  executionWorkspaceRoot?: string;
  runLogScope?: RalphFlowScope;
  roots: Array<{
    path: string;
    workspaceRoot?: string;
    include?: string[];
    exclude?: string[];
  }>;
  events?: RalphWatchEventType[];
  params?: Record<string, string>;
  permissions?: Partial<RalphWatchPermissionProfile>;
  debounceMs?: number;
  stabilityMs?: number;
  pollIntervalMs?: number;
  cooldownMs?: number;
  maxEventsPerWindow?: Partial<RalphWatchDefinition["maxEventsPerWindow"]>;
  maxTransitions?: number;
  concurrencyLimit?: number;
  allowDangerousRoots?: boolean;
}

export interface RalphWatchFileEvent {
  type: RalphWatchEventType;
  path: string;
  rootPath: string;
  relativePath: string;
  size?: number;
  mtimeMs?: number;
  isDirectory?: boolean;
  occurredAt: number;
}

export interface RalphWatchServiceOptions {
  scheduler: DurableSmartScheduler;
  onError?: (watch: RalphWatchDefinition, error: unknown) => void | Promise<void>;
  onEvent?: (
    watch: RalphWatchDefinition,
    event: RalphWatchFileEvent,
    result: ScheduledTriggerEventResult,
  ) => void | Promise<void>;
}

interface WatchHandle {
  stop(): void;
}

interface FileSnapshot {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export const getRalphWatchStatePath = (): string => {
  return join(getUserRalphDirectory(), RALPH_WATCH_FILE_NAME);
};

const createEmptyState = (): RalphWatchState => {
  const now = new Date().toISOString();

  return {
    schema: RALPH_WATCH_SCHEMA,
    schemaVersion: RALPH_WATCH_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    watches: [],
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeId = (value: string | undefined): string => {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);

  return normalized || `watch-${randomUUID()}`;
};

const normalizePositiveInteger = (
  value: number | undefined,
  fallback: number,
): number => {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.trunc(value)
    : fallback;
};

const normalizeScope = (
  value: string | undefined,
  fallback: RalphFlowScope,
): RalphFlowScope => {
  return value === "user" || value === "workspace" ? value : fallback;
};

const normalizeEvents = (
  events: RalphWatchEventType[] | undefined,
): RalphWatchEventType[] => {
  const normalized = Array.from(
    new Set(
      (events && events.length > 0 ? events : ["created", "changed"])
        .filter((event): event is RalphWatchEventType =>
          WATCH_EVENT_TYPES.includes(event as RalphWatchEventType),
        ),
    ),
  );

  if (normalized.length === 0) {
    throw new Error("Expected Ralph watch to include at least one event type.");
  }

  return normalized;
};

const isPathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const canonicalizeExistingPath = async (path: string): Promise<string> => {
  const resolved = resolve(path);

  return existsSync(resolved) ? realpath(resolved) : resolved;
};

const assertDirectory = async (path: string, label: string): Promise<void> => {
  const metadata = await stat(path);

  if (!metadata.isDirectory()) {
    throw new Error(`Expected ${label} to be a directory: ${path}`);
  }
};

const isDangerousRoot = (path: string): boolean => {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  const home = resolve(homedir());

  return (
    resolved === root ||
    resolved === home ||
    DANGEROUS_PATH_PATTERN.test(resolved)
  );
};

const normalizeWatchPath = async (
  path: string,
  label: string,
  allowDangerousRoots: boolean,
): Promise<string> => {
  const trimmed = path.trim();

  if (!trimmed || !isAbsolute(trimmed)) {
    throw new Error(`Expected ${label} to be an absolute path.`);
  }

  const resolved = await canonicalizeExistingPath(trimmed);
  await assertDirectory(resolved, label);

  if (!allowDangerousRoots && isDangerousRoot(resolved)) {
    throw new Error(`Refusing to watch dangerous or overly broad path: ${resolved}`);
  }

  return resolved;
};

const normalizeStringList = (values: string[] | undefined): string[] => {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim().replace(/\\/gu, "/"))
        .filter(Boolean),
    ),
  );
};

const normalizeRoot = async (
  root: RalphWatchInput["roots"][number],
  allowDangerousRoots: boolean,
): Promise<RalphWatchRoot> => {
  const path = await normalizeWatchPath(root.path, "watch root", allowDangerousRoots);
  const workspaceRoot = root.workspaceRoot
    ? await normalizeWatchPath(root.workspaceRoot, "watch workspace root", true)
    : undefined;

  if (workspaceRoot && !isPathInside(workspaceRoot, path) && !isPathInside(path, workspaceRoot)) {
    throw new Error(
      `Watch root ${path} and workspace root ${workspaceRoot} do not overlap.`,
    );
  }

  return {
    path,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    include: normalizeStringList(root.include),
    exclude: Array.from(new Set([...DEFAULT_EXCLUDES, ...normalizeStringList(root.exclude)])),
  };
};

const normalizePermissionProfile = async (
  input: RalphWatchInput,
  roots: RalphWatchRoot[],
): Promise<RalphWatchPermissionProfile> => {
  const allowedRootsInput = input.permissions?.allowedRoots;
  const allowedRoots = await Promise.all(
    (allowedRootsInput && allowedRootsInput.length > 0
      ? allowedRootsInput
      : roots.map((root) => root.path)
    ).map((path) =>
      normalizeWatchPath(
        path,
        "allowed root",
        input.allowDangerousRoots === true,
      ),
    ),
  );

  for (const allowedRoot of allowedRoots) {
    if (!roots.some((root) => isPathInside(root.path, allowedRoot))) {
      throw new Error(`Allowed root ${allowedRoot} is outside the watched roots.`);
    }
  }

  return {
    allowedRoots: Array.from(new Set(allowedRoots)),
    allowCommands: input.permissions?.allowCommands ?? false,
    allowWrites: input.permissions?.allowWrites ?? false,
    allowNetwork: input.permissions?.allowNetwork ?? false,
    allowMcpTools: input.permissions?.allowMcpTools ?? false,
  };
};

export const normalizeRalphWatchInput = async (
  input: RalphWatchInput,
  existing?: RalphWatchDefinition,
): Promise<RalphWatchDefinition> => {
  const roots = await Promise.all(
    input.roots.map((root) =>
      normalizeRoot(root, input.allowDangerousRoots === true),
    ),
  );

  if (roots.length === 0) {
    throw new Error("Expected Ralph watch to include at least one root.");
  }

  const executionWorkspaceRoot = input.executionWorkspaceRoot
    ? await normalizeWatchPath(input.executionWorkspaceRoot, "execution workspace root", true)
    : roots[0]?.workspaceRoot ?? roots[0]?.path;

  if (!executionWorkspaceRoot) {
    throw new Error("Expected Ralph watch to include an execution workspace.");
  }

  const maxTransitions = input.maxTransitions;

  if (
    maxTransitions !== undefined &&
    (!Number.isInteger(maxTransitions) || maxTransitions < 1)
  ) {
    throw new Error("Expected maxTransitions to be an integer >= 1.");
  }

  const now = new Date().toISOString();
  const id = normalizeId(input.id ?? existing?.id);
  const name = normalizeOptionalString(input.name ?? existing?.name);
  const runLogScope = input.runLogScope ?? existing?.runLogScope;
  const cooldownMs = input.cooldownMs ?? existing?.cooldownMs;
  const retainedMaxTransitions = maxTransitions ?? existing?.maxTransitions;
  const permissions = await normalizePermissionProfile(input, roots);

  if (!permissions.allowedRoots.some((root) => isPathInside(root, executionWorkspaceRoot))) {
    throw new Error(
      `Execution workspace ${executionWorkspaceRoot} is outside the watch allowed roots.`,
    );
  }

  return {
    id,
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(name ? { name } : {}),
    flow: {
      scope: normalizeScope(input.flow.scope, existing?.flow.scope ?? "workspace"),
      id: normalizeId(input.flow.id),
    },
    executionWorkspaceRoot,
    ...(runLogScope
      ? { runLogScope: normalizeScope(runLogScope, "workspace") }
      : {}),
    roots,
    events: normalizeEvents(input.events ?? existing?.events),
    params: { ...(existing?.params ?? {}), ...(input.params ?? {}) },
    permissions,
    debounceMs: normalizePositiveInteger(
      input.debounceMs ?? existing?.debounceMs,
      DEFAULT_DEBOUNCE_MS,
    ),
    stabilityMs: normalizePositiveInteger(
      input.stabilityMs ?? existing?.stabilityMs,
      DEFAULT_STABILITY_MS,
    ),
    pollIntervalMs: normalizePositiveInteger(
      input.pollIntervalMs ?? existing?.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    ...(cooldownMs
      ? { cooldownMs: normalizePositiveInteger(cooldownMs, 1) }
      : {}),
    maxEventsPerWindow: {
      maxEvents: normalizePositiveInteger(
        input.maxEventsPerWindow?.maxEvents ?? existing?.maxEventsPerWindow.maxEvents,
        DEFAULT_MAX_EVENTS_PER_WINDOW,
      ),
      windowMs: normalizePositiveInteger(
        input.maxEventsPerWindow?.windowMs ?? existing?.maxEventsPerWindow.windowMs,
        DEFAULT_RATE_WINDOW_MS,
      ),
    },
    ...(retainedMaxTransitions !== undefined
      ? { maxTransitions: retainedMaxTransitions }
      : {}),
    concurrencyLimit: normalizePositiveInteger(
      input.concurrencyLimit ?? existing?.concurrencyLimit,
      1,
    ),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastError ? { lastError: existing.lastError } : {}),
  };
};

export const loadRalphWatchState = async (): Promise<RalphWatchState> => {
  const path = getRalphWatchStatePath();

  if (!existsSync(path)) {
    return createEmptyState();
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

  if (
    !isRecord(parsed) ||
    parsed.schema !== RALPH_WATCH_SCHEMA ||
    parsed.schemaVersion !== RALPH_WATCH_SCHEMA_VERSION ||
    !Array.isArray(parsed.watches)
  ) {
    throw new Error(`Unsupported Ralph watch state file: ${path}`);
  }

  return parsed as unknown as RalphWatchState;
};

export const saveRalphWatchState = async (
  state: RalphWatchState,
): Promise<string> => {
  const path = getRalphWatchStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  return path;
};

export const listRalphWatches = async (): Promise<RalphWatchDefinition[]> => {
  return (await loadRalphWatchState()).watches;
};

export const upsertRalphWatch = async (
  input: RalphWatchInput,
): Promise<RalphWatchDefinition> => {
  const state = await loadRalphWatchState();
  const id = normalizeId(input.id);
  const existing = state.watches.find((watch) => watch.id === id);
  const watchDefinition = await normalizeRalphWatchInput(input, existing);
  const nextWatches = existing
    ? state.watches.map((watch) =>
        watch.id === watchDefinition.id ? watchDefinition : watch,
      )
    : [...state.watches, watchDefinition];
  const now = new Date().toISOString();

  await saveRalphWatchState({
    ...state,
    updatedAt: now,
    watches: nextWatches.sort((left, right) => left.id.localeCompare(right.id)),
  });

  return watchDefinition;
};

export const deleteRalphWatch = async (id: string): Promise<RalphWatchDefinition> => {
  const normalizedId = normalizeId(id);
  const state = await loadRalphWatchState();
  const match = state.watches.find((watch) => watch.id === normalizedId);

  if (!match) {
    throw new Error(`Ralph watch not found: ${id}`);
  }

  await saveRalphWatchState({
    ...state,
    updatedAt: new Date().toISOString(),
    watches: state.watches.filter((watch) => watch.id !== normalizedId),
  });

  return match;
};

const globToRegExp = (glob: string): RegExp => {
  const normalized = glob.replace(/\\/gu, "/");
  let pattern = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += char?.replace(/[.+^${}()|[\]\\]/gu, "\\$&") ?? "";
  }

  return new RegExp(`^${pattern}$`, "iu");
};

const pathMatchesAnyGlob = (path: string, globs: string[]): boolean => {
  return globs.some((glob) => globToRegExp(glob).test(path));
};

export const watchRootMatchesPath = (
  root: RalphWatchRoot,
  absolutePath: string,
): boolean => {
  const resolvedPath = resolve(absolutePath);

  if (!isPathInside(root.path, resolvedPath)) {
    return false;
  }

  const relativePath = relative(root.path, resolvedPath).split(sep).join("/");

  if (root.include.length > 0 && !pathMatchesAnyGlob(relativePath, root.include)) {
    return false;
  }

  if (pathMatchesAnyGlob(relativePath, root.exclude)) {
    return false;
  }

  return true;
};

const watchRootCanTraversePath = (
  root: RalphWatchRoot,
  absolutePath: string,
): boolean => {
  const resolvedPath = resolve(absolutePath);

  if (!isPathInside(root.path, resolvedPath)) {
    return false;
  }

  const relativePath = relative(root.path, resolvedPath).split(sep).join("/");

  if (!relativePath) {
    return true;
  }

  return (
    !pathMatchesAnyGlob(relativePath, root.exclude) &&
    !pathMatchesAnyGlob(`${relativePath}/__machdoch_watch_probe__`, root.exclude)
  );
};

const createWatchEventPayload = (
  watchDefinition: RalphWatchDefinition,
  event: RalphWatchFileEvent,
): Record<string, unknown> => ({
  watchId: watchDefinition.id,
  eventType: event.type,
  path: event.path,
  rootPath: event.rootPath,
  relativePath: event.relativePath,
  size: event.size,
  mtimeMs: event.mtimeMs,
  isDirectory: event.isDirectory,
  flowScope: watchDefinition.flow.scope,
  flowId: watchDefinition.flow.id,
});

export const createRalphWatchSchedulerJobInput = (
  watchDefinition: RalphWatchDefinition,
): CreateScheduledJobInput => ({
  name: watchDefinition.name ?? `Ralph watch ${watchDefinition.id}`,
  triggers: [
    {
      kind: "workspace-file",
      eventType: "workspace-file.*",
      filters: { "payload.watchId": watchDefinition.id },
      debounceMs: watchDefinition.debounceMs,
      ...(watchDefinition.cooldownMs ? { cooldownMs: watchDefinition.cooldownMs } : {}),
      dedupeKeyTemplate: "{payload.watchId}:{payload.eventType}:{payload.path}:{payload.mtimeMs}",
      maxEventsPerWindow: watchDefinition.maxEventsPerWindow,
    },
  ],
  target: {
    type: "ralph-flow",
    workspaceRoot: watchDefinition.executionWorkspaceRoot,
    ralphFlow: {
      scope: watchDefinition.flow.scope,
      id: watchDefinition.flow.id,
      params: watchDefinition.params,
      ...(watchDefinition.runLogScope ? { runLogScope: watchDefinition.runLogScope } : {}),
      ...(watchDefinition.maxTransitions !== undefined
        ? { maxTransitions: watchDefinition.maxTransitions }
        : {}),
      permissions: watchDefinition.permissions,
    },
  },
  retry: { maxAttempts: 1 },
  queue: {
    concurrencyKey: `ralph-watch:${watchDefinition.id}`,
    concurrencyLimit: watchDefinition.concurrencyLimit,
  },
  dedupeKey: `ralph-watch:${watchDefinition.id}`,
});

export const syncRalphWatchSchedulerJobs = async (
  scheduler = new DurableSmartScheduler({ statePath: getUserSchedulerStatePath() }),
): Promise<void> => {
  const watches = await listRalphWatches();
  const activeDedupeKeys = new Set<string>();

  for (const watchDefinition of watches) {
    activeDedupeKeys.add(`ralph-watch:${watchDefinition.id}`);
    const job = await scheduler.upsertJob(
      createRalphWatchSchedulerJobInput(watchDefinition),
    );

    if (watchDefinition.enabled && job.status === "paused") {
      await scheduler.resumeJob(job.id);
    } else if (!watchDefinition.enabled && job.status === "active") {
      await scheduler.pauseJob(job.id);
    }
  }

  const jobs = await scheduler.listJobs();

  for (const job of jobs) {
    if (
      job.dedupeKey?.startsWith("ralph-watch:") &&
      !activeDedupeKeys.has(job.dedupeKey)
    ) {
      await scheduler.deleteJob(job.id);
    }
  }
};

export const emitRalphWatchEvent = async (
  scheduler: DurableSmartScheduler,
  watchDefinition: RalphWatchDefinition,
  event: RalphWatchFileEvent,
): Promise<ScheduledTriggerEventResult> => {
  const input: ScheduledTriggerEventInput = {
    type: `workspace-file.${event.type}`,
    kind: "workspace-file",
    source: "watcher",
    workspaceRoot: watchDefinition.executionWorkspaceRoot,
    payload: createWatchEventPayload(watchDefinition, event),
    dedupeKey: `${watchDefinition.id}:${event.type}:${event.path}:${event.mtimeMs ?? event.occurredAt}`,
    occurredAt: event.occurredAt,
  };

  return scheduler.recordEventAndEnqueueRuns(input);
};

const getFileSnapshot = async (path: string): Promise<FileSnapshot | undefined> => {
  try {
    const metadata = await stat(path);

    return {
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      isDirectory: metadata.isDirectory(),
    };
  } catch {
    return undefined;
  }
};

const waitForStableFile = async (
  path: string,
  stabilityMs: number,
): Promise<FileSnapshot | undefined> => {
  let previous = await getFileSnapshot(path);

  if (!previous || previous.isDirectory) {
    return previous;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, stabilityMs);
    });

    const current = await getFileSnapshot(path);

    if (
      current &&
      previous &&
      current.size === previous.size &&
      current.mtimeMs === previous.mtimeMs
    ) {
      return current;
    }

    previous = current;
  }

  return previous;
};

const scanFiles = async (
  root: RalphWatchRoot,
  directory = root.path,
  snapshots = new Map<string, FileSnapshot>(),
): Promise<Map<string, FileSnapshot>> => {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return snapshots;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (!watchRootCanTraversePath(root, path)) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      const snapshot = await getFileSnapshot(path);

      if (snapshot && watchRootMatchesPath(root, path)) {
        snapshots.set(path, snapshot);
      }

      await scanFiles(root, path, snapshots);
      continue;
    }

    if (entry.isFile()) {
      const snapshot = await getFileSnapshot(path);

      if (snapshot && watchRootMatchesPath(root, path)) {
        snapshots.set(path, snapshot);
      }
    }
  }

  return snapshots;
};

export class RalphWatchService {
  private readonly scheduler: DurableSmartScheduler;
  private readonly onError:
    | ((watch: RalphWatchDefinition, error: unknown) => void | Promise<void>)
    | undefined;
  private readonly onEvent:
    | ((
        watch: RalphWatchDefinition,
        event: RalphWatchFileEvent,
        result: ScheduledTriggerEventResult,
      ) => void | Promise<void>)
    | undefined;
  private handles: WatchHandle[] = [];
  private stopped = true;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: RalphWatchServiceOptions) {
    this.scheduler = options.scheduler;
    this.onError = options.onError;
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    await syncRalphWatchSchedulerJobs(this.scheduler);
    const watches = (await listRalphWatches()).filter((watchDefinition) =>
      watchDefinition.enabled,
    );

    this.stopped = false;

    for (const watchDefinition of watches) {
      for (const root of watchDefinition.roots) {
        this.handles.push(await this.startRoot(watchDefinition, root));
      }
    }
  }

  stop(): void {
    this.stopped = true;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }

    this.debounceTimers.clear();

    for (const handle of this.handles) {
      handle.stop();
    }

    this.handles = [];
  }

  private async startRoot(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
  ): Promise<WatchHandle> {
    if (process.platform === "win32" || process.platform === "darwin") {
      try {
        const watcher = watch(root.path, { recursive: true }, (eventName, fileName) => {
          const candidatePath = fileName
            ? resolve(root.path, String(fileName))
            : root.path;
          void this.queueNativeEvent(watchDefinition, root, eventName, candidatePath);
        });

        watcher.on("error", (error) => {
          void this.reportError(watchDefinition, error);
        });

        return {
          stop: () => watcher.close(),
        };
      } catch (error) {
        await this.reportError(watchDefinition, error);
      }
    }

    return this.startPollingRoot(watchDefinition, root);
  }

  private async startPollingRoot(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
  ): Promise<WatchHandle> {
    let previous = await scanFiles(root);
    const timer = setInterval(() => {
      if (this.stopped) {
        return;
      }

      void (async () => {
        const current = await scanFiles(root);
        const now = Date.now();

        for (const [path, snapshot] of current.entries()) {
          const oldSnapshot = previous.get(path);

          if (!oldSnapshot) {
            this.queueEvent(watchDefinition, root, "created", path, snapshot, now);
          } else if (
            oldSnapshot.size !== snapshot.size ||
            oldSnapshot.mtimeMs !== snapshot.mtimeMs
          ) {
            this.queueEvent(watchDefinition, root, "changed", path, snapshot, now);
          }
        }

        for (const [path, snapshot] of previous.entries()) {
          if (!current.has(path)) {
            this.queueEvent(watchDefinition, root, "deleted", path, snapshot, now);
          }
        }

        previous = current;
      })().catch((error) => {
        void this.reportError(watchDefinition, error);
      });
    }, watchDefinition.pollIntervalMs);

    return {
      stop: () => clearInterval(timer),
    };
  }

  private async queueNativeEvent(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
    eventName: string,
    candidatePath: string,
  ): Promise<void> {
    if (!watchRootMatchesPath(root, candidatePath)) {
      return;
    }

    const snapshot = await waitForStableFile(candidatePath, watchDefinition.stabilityMs);
    const eventType: RalphWatchEventType =
      eventName === "rename"
        ? snapshot
          ? "created"
          : "deleted"
        : "changed";

    this.queueEvent(watchDefinition, root, eventType, candidatePath, snapshot, Date.now());
  }

  private queueEvent(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
    eventType: RalphWatchEventType,
    path: string,
    snapshot: FileSnapshot | undefined,
    occurredAt: number,
  ): void {
    if (!watchDefinition.events.includes(eventType)) {
      return;
    }

    const key = `${watchDefinition.id}:${eventType}:${path}`;
    const existing = this.debounceTimers.get(key);

    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.emit(watchDefinition, root, eventType, path, snapshot, occurredAt);
    }, watchDefinition.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  private async emit(
    watchDefinition: RalphWatchDefinition,
    root: RalphWatchRoot,
    eventType: RalphWatchEventType,
    path: string,
    snapshot: FileSnapshot | undefined,
    occurredAt: number,
  ): Promise<void> {
    if (this.stopped || !watchRootMatchesPath(root, path)) {
      return;
    }

    const event: RalphWatchFileEvent = {
      type: eventType,
      path,
      rootPath: root.path,
      relativePath: relative(root.path, path).split(sep).join("/"),
      ...(snapshot?.size !== undefined ? { size: snapshot.size } : {}),
      ...(snapshot?.mtimeMs !== undefined ? { mtimeMs: snapshot.mtimeMs } : {}),
      ...(snapshot?.isDirectory !== undefined ? { isDirectory: snapshot.isDirectory } : {}),
      occurredAt,
    };

    try {
      const result = await emitRalphWatchEvent(this.scheduler, watchDefinition, event);
      await this.scheduler.runQueuedRuns({ maxRuns: 1 });
      await this.onEvent?.(watchDefinition, event, result);
    } catch (error) {
      await this.reportError(watchDefinition, error);
    }
  }

  private async reportError(
    watchDefinition: RalphWatchDefinition,
    error: unknown,
  ): Promise<void> {
    await this.onError?.(watchDefinition, error);
  }
}

export const createUserRalphWatchScheduler = (
  executor?: ConstructorParameters<typeof DurableSmartScheduler>[0]["executor"],
): DurableSmartScheduler => {
  return new DurableSmartScheduler({
    statePath: getUserSchedulerStatePath(),
    ...(executor ? { executor } : {}),
  });
};

export const getRalphWatchIgnoredRoots = (workspaceRoot: string): string[] => [
  getRalphStorageDirectory(workspaceRoot, "workspace"),
  getRalphStorageDirectory(workspaceRoot, "user"),
];
