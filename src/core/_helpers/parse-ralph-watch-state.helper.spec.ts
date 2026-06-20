import {
  RALPH_WATCH_SCHEMA,
  RALPH_WATCH_SCHEMA_VERSION,
} from "./create-empty-ralph-watch-state.helper.ts";
import { parseRalphWatchState } from "./parse-ralph-watch-state.helper.ts";
import type { RalphWatchState } from "../ralph-watches.ts";

const statePath = "C:\\Users\\test\\.machdoch\\ralph\\watches.json";

const createState = (
  override: Partial<RalphWatchState> = {},
): RalphWatchState => ({
  schema: RALPH_WATCH_SCHEMA,
  schemaVersion: RALPH_WATCH_SCHEMA_VERSION,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  watches: [],
  ...override,
});

describe("parseRalphWatchState", () => {
  it("returns a valid state without changing persisted data", () => {
    const state = createState({
      watches: [
        {
          id: "watch-1",
          enabled: true,
          flow: { scope: "workspace", id: "flow-1" },
          executionWorkspaceRoot: "C:\\Workspace",
          roots: [],
          events: ["created"],
          params: {},
          permissions: {
            allowedRoots: ["C:\\Workspace"],
            allowCommands: false,
            allowWrites: false,
            allowNetwork: false,
            allowMcpTools: false,
          },
          debounceMs: 1_000,
          stabilityMs: 300,
          pollIntervalMs: 5_000,
          maxEventsPerWindow: { maxEvents: 100, windowMs: 60_000 },
          concurrencyLimit: 1,
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });

    expect(parseRalphWatchState(state, statePath)).toBe(state);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["array", []],
    ["wrong schema", createState({ schema: "other" as typeof RALPH_WATCH_SCHEMA })],
    ["wrong schema version", createState({ schemaVersion: 2 as typeof RALPH_WATCH_SCHEMA_VERSION })],
    ["missing watches", { ...createState(), watches: undefined }],
    ["non-array watches", { ...createState(), watches: {} }],
  ])("rejects invalid state input: %s", (_label, value) => {
    expect(() => parseRalphWatchState(value, statePath)).toThrow(
      `Unsupported Ralph watch state file: ${statePath}`,
    );
  });
});
