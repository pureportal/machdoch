import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import { normalizeWatchPathPatterns } from "./normalize-watch-path-patterns.helper.js";
import type {
  RalphWatchDefinition,
  RalphWatchEventType,
  RalphWatchInput,
  RalphWatchPermissionProfile,
  RalphWatchRoot,
} from "../ralph-watches.js";
import type { RalphFlowScope } from "../ralph.js";

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

export const normalizeRalphWatchId = (value: string | undefined): string => {
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

const normalizeRoot = async (
  root: RalphWatchInput["roots"][number],
  allowDangerousRoots: boolean,
): Promise<RalphWatchRoot> => {
  const path = await normalizeWatchPath(root.path, "watch root", allowDangerousRoots);
  const workspaceRoot = root.workspaceRoot
    ? await normalizeWatchPath(root.workspaceRoot, "watch workspace root", true)
    : undefined;

  if (
    workspaceRoot &&
    !isPathInside(workspaceRoot, path) &&
    !isPathInside(path, workspaceRoot)
  ) {
    throw new Error(
      `Watch root ${path} and workspace root ${workspaceRoot} do not overlap.`,
    );
  }

  return {
    path,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    include: normalizeWatchPathPatterns(root.include),
    exclude: Array.from(
      new Set([...DEFAULT_EXCLUDES, ...normalizeWatchPathPatterns(root.exclude)]),
    ),
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
  const id = normalizeRalphWatchId(input.id ?? existing?.id);
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
      id: normalizeRalphWatchId(input.flow.id),
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
