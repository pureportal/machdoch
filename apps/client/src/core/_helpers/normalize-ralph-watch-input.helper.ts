import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import { normalizeRalphWatchEvents } from "./normalize-ralph-watch-events.helper.js";
import { normalizeRalphWatchId } from "./normalize-ralph-watch-id.helper.js";
import { isPathInside, normalizeRalphWatchPath } from "./normalize-ralph-watch-path.helper.js";
import { normalizeRalphWatchPermissionProfile } from "./normalize-ralph-watch-permission-profile.helper.js";
import { normalizeRalphWatchPositiveInteger } from "./normalize-ralph-watch-positive-integer.helper.js";
import { normalizeRalphWatchRoot } from "./normalize-ralph-watch-root.helper.js";
import { normalizeRalphWatchScope } from "./normalize-ralph-watch-scope.helper.js";
import type {
  RalphWatchDefinition,
  RalphWatchInput,
} from "../ralph-watches.js";

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_STABILITY_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_EVENTS_PER_WINDOW = 100;
const DEFAULT_RATE_WINDOW_MS = 60_000;

export { normalizeRalphWatchId } from "./normalize-ralph-watch-id.helper.js";

export const normalizeRalphWatchInput = async (
  input: RalphWatchInput,
  existing?: RalphWatchDefinition,
): Promise<RalphWatchDefinition> => {
  const roots = await Promise.all(
    input.roots.map((root) =>
      normalizeRalphWatchRoot(root, input.allowDangerousRoots === true),
    ),
  );

  if (roots.length === 0) {
    throw new Error("Expected Ralph watch to include at least one root.");
  }

  const executionWorkspaceRoot = input.executionWorkspaceRoot
    ? await normalizeRalphWatchPath(
        input.executionWorkspaceRoot,
        "execution workspace root",
        true,
      )
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
  const permissions = await normalizeRalphWatchPermissionProfile(input, roots);

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
      scope: normalizeRalphWatchScope(
        input.flow.scope,
        existing?.flow.scope ?? "workspace",
      ),
      id: normalizeRalphWatchId(input.flow.id),
    },
    executionWorkspaceRoot,
    ...(runLogScope
      ? { runLogScope: normalizeRalphWatchScope(runLogScope, "workspace") }
      : {}),
    roots,
    events: normalizeRalphWatchEvents(input.events ?? existing?.events),
    params: { ...(existing?.params ?? {}), ...(input.params ?? {}) },
    permissions,
    debounceMs: normalizeRalphWatchPositiveInteger(
      input.debounceMs ?? existing?.debounceMs,
      DEFAULT_DEBOUNCE_MS,
    ),
    stabilityMs: normalizeRalphWatchPositiveInteger(
      input.stabilityMs ?? existing?.stabilityMs,
      DEFAULT_STABILITY_MS,
    ),
    pollIntervalMs: normalizeRalphWatchPositiveInteger(
      input.pollIntervalMs ?? existing?.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    ...(cooldownMs
      ? { cooldownMs: normalizeRalphWatchPositiveInteger(cooldownMs, 1) }
      : {}),
    maxEventsPerWindow: {
      maxEvents: normalizeRalphWatchPositiveInteger(
        input.maxEventsPerWindow?.maxEvents ?? existing?.maxEventsPerWindow.maxEvents,
        DEFAULT_MAX_EVENTS_PER_WINDOW,
      ),
      windowMs: normalizeRalphWatchPositiveInteger(
        input.maxEventsPerWindow?.windowMs ?? existing?.maxEventsPerWindow.windowMs,
        DEFAULT_RATE_WINDOW_MS,
      ),
    },
    ...(retainedMaxTransitions !== undefined
      ? { maxTransitions: retainedMaxTransitions }
      : {}),
    concurrencyLimit: normalizeRalphWatchPositiveInteger(
      input.concurrencyLimit ?? existing?.concurrencyLimit,
      1,
    ),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastError ? { lastError: existing.lastError } : {}),
  };
};
