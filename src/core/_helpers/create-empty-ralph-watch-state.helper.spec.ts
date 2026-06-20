import {
  RALPH_WATCH_FILE_NAME,
  RALPH_WATCH_SCHEMA,
  RALPH_WATCH_SCHEMA_VERSION,
  createEmptyRalphWatchState,
} from "./create-empty-ralph-watch-state.helper.ts";

describe("createEmptyRalphWatchState", () => {
  it("creates an empty persisted watch state with a stable schema", () => {
    const state = createEmptyRalphWatchState("2026-06-20T00:00:00.000Z");

    expect(state).toEqual({
      schema: RALPH_WATCH_SCHEMA,
      schemaVersion: RALPH_WATCH_SCHEMA_VERSION,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      watches: [],
    });
    expect(RALPH_WATCH_FILE_NAME).toBe("watches.json");
  });

  it("uses the current time when no timestamp is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T01:02:03.004Z"));

    expect(createEmptyRalphWatchState()).toMatchObject({
      createdAt: "2026-06-20T01:02:03.004Z",
      updatedAt: "2026-06-20T01:02:03.004Z",
    });
  });
});
