import type { RalphWatchState } from "../ralph-watches.js";

export const RALPH_WATCH_SCHEMA = "machdoch.ralphWatches" as const;
export const RALPH_WATCH_SCHEMA_VERSION = 1 as const;
export const RALPH_WATCH_FILE_NAME = "watches.json";

export const createEmptyRalphWatchState = (
  now = new Date().toISOString(),
): RalphWatchState => {
  return {
    schema: RALPH_WATCH_SCHEMA,
    schemaVersion: RALPH_WATCH_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    watches: [],
  };
};
