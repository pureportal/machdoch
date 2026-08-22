import {
  RALPH_WATCH_SCHEMA,
  RALPH_WATCH_SCHEMA_VERSION,
} from "./create-empty-ralph-watch-state.helper.js";
import type { RalphWatchState } from "../ralph-watches.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const parseRalphWatchState = (
  value: unknown,
  path: string,
): RalphWatchState => {
  if (
    !isRecord(value) ||
    value.schema !== RALPH_WATCH_SCHEMA ||
    value.schemaVersion !== RALPH_WATCH_SCHEMA_VERSION ||
    !Array.isArray(value.watches)
  ) {
    throw new Error(`Unsupported Ralph watch state file: ${path}`);
  }

  return value as unknown as RalphWatchState;
};
