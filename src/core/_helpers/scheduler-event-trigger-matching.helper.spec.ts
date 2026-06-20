import {
  createSchedulerEventRunDedupeSuffix,
  getSchedulerEventTriggerRecoveryMatched,
  getSchedulerStatefulTriggerSkipReason,
  getSchedulerTriggerCooldownSkipReason,
  getSchedulerTriggerRateLimitSkipReason,
  normalizeSchedulerEventPayload,
  schedulerEventFiltersMatch,
  schedulerEventTypeMatches,
  type SchedulerEventTrigger,
  type SchedulerTriggerEvent,
} from "./scheduler-event-trigger-matching.helper.ts";

const createTrigger = (
  overrides: Partial<SchedulerEventTrigger> = {},
): SchedulerEventTrigger => ({
  id: "trigger-1",
  kind: "workspace-file",
  eventType: "workspace.file.changed",
  ...overrides,
});

const createEvent = (
  overrides: Partial<SchedulerTriggerEvent> = {},
): SchedulerTriggerEvent => ({
  id: "event-1",
  type: "workspace.file.changed",
  kind: "workspace-file",
  source: "watcher",
  workspaceRoot: "/workspace",
  payload: {
    path: "src/app.ts",
    extension: "ts",
    size: 42,
    tags: ["source"],
  },
  dedupeKey: "dedupe-1",
  receivedAt: 10_000,
  matches: [],
  ...overrides,
});

describe("schedulerEventTypeMatches", () => {
  it("matches exact, wildcard, and glob-like event types for the same kind", () => {
    const event = createEvent();

    expect(schedulerEventTypeMatches(createTrigger(), event)).toBe(true);
    expect(
      schedulerEventTypeMatches(createTrigger({ eventType: "*" }), event),
    ).toBe(true);
    expect(
      schedulerEventTypeMatches(
        createTrigger({ eventType: "workspace.file.*" }),
        event,
      ),
    ).toBe(true);
  });

  it("rejects different trigger kinds and non-matching patterns", () => {
    const event = createEvent();

    expect(
      schedulerEventTypeMatches(createTrigger({ kind: "git" }), event),
    ).toBe(false);
    expect(
      schedulerEventTypeMatches(createTrigger({ eventType: "git.*" }), event),
    ).toBe(false);
  });
});

describe("schedulerEventFiltersMatch", () => {
  it("matches empty filters and nested payload paths", () => {
    const event = createEvent();

    expect(schedulerEventFiltersMatch(createTrigger(), event)).toBe(true);
    expect(
      schedulerEventFiltersMatch(
        createTrigger({
          filters: {
            "payload.path": "src/*.ts",
            "payload.extension": ["tsx", "ts"],
          },
        }),
        event,
      ),
    ).toBe(true);
  });

  it("supports numeric, string, and existence filter expressions", () => {
    const event = createEvent();

    expect(
      schedulerEventFiltersMatch(
        createTrigger({
          filters: {
            "payload.size": { op: ">=", value: "42" },
            "payload.path": { operator: "contains", value: "app" },
            "payload.missing": { op: "exists", value: false },
          },
        }),
        event,
      ),
    ).toBe(true);
  });

  it("rejects invalid, empty, and unmatched filter values", () => {
    const event = createEvent();

    expect(
      schedulerEventFiltersMatch(
        createTrigger({ filters: { "payload.size": { op: ">", value: "NaN" } } }),
        event,
      ),
    ).toBe(false);
    expect(
      schedulerEventFiltersMatch(
        createTrigger({ filters: { "payload.path": { op: "prefix", value: "" } } }),
        event,
      ),
    ).toBe(true);
    expect(
      schedulerEventFiltersMatch(
        createTrigger({ filters: { "payload.extension": "js" } }),
        event,
      ),
    ).toBe(false);
  });
});

describe("createSchedulerEventRunDedupeSuffix", () => {
  it("uses the trigger id and event dedupe key by default", () => {
    expect(
      createSchedulerEventRunDedupeSuffix(
        { id: "job-1" },
        createTrigger(),
        createEvent(),
      ),
    ).toBe("trigger-1:dedupe-1");
  });

  it("renders templates with missing values as empty strings", () => {
    expect(
      createSchedulerEventRunDedupeSuffix(
        { id: "job-1" },
        createTrigger({
          dedupeKeyTemplate:
            "{jobId}:{triggerId}:{eventType}:{payload.path}:{payload.missing}",
        }),
        createEvent(),
      ),
    ).toBe("job-1:trigger-1:workspace.file.changed:src/app.ts:");
  });

  it("adds a state repeat bucket for stateful triggers", () => {
    expect(
      createSchedulerEventRunDedupeSuffix(
        { id: "job-1" },
        createTrigger({
          firingMode: "state",
          lastStateChangedAt: 1_000,
          repeatIntervalMs: 2_000,
        }),
        createEvent({ receivedAt: 5_100 }),
      ),
    ).toBe("trigger-1:dedupe-1:state:1000:2");
  });
});

describe("scheduler trigger skip and recovery helpers", () => {
  it("uses recovery filters when present and inverted activation otherwise", () => {
    const event = createEvent({ payload: { recovered: true } });

    expect(
      getSchedulerEventTriggerRecoveryMatched(
        createTrigger({ recoveryFilters: { "payload.recovered": true } }),
        event,
        true,
      ),
    ).toBe(true);
    expect(
      getSchedulerEventTriggerRecoveryMatched(createTrigger(), event, false),
    ).toBe(true);
  });

  it("returns stateful and cooldown skip reasons only before boundaries", () => {
    const event = createEvent({ receivedAt: 10_000 });

    expect(
      getSchedulerStatefulTriggerSkipReason(
        createTrigger({
          firingMode: "state",
          lastState: "active",
          lastFiredAt: 9_000,
          repeatIntervalMs: 2_000,
        }),
        event,
      ),
    ).toContain("2000ms");
    expect(
      getSchedulerStatefulTriggerSkipReason(
        createTrigger({
          firingMode: "state",
          lastState: "active",
          lastFiredAt: 8_000,
          repeatIntervalMs: 2_000,
        }),
        event,
      ),
    ).toBeUndefined();

    expect(
      getSchedulerTriggerCooldownSkipReason(
        createTrigger({ lastFiredAt: 9_500, cooldownMs: 1_000 }),
        event,
      ),
    ).toContain("1000ms");
    expect(
      getSchedulerTriggerCooldownSkipReason(
        createTrigger({ lastFiredAt: 9_000, cooldownMs: 1_000 }),
        event,
      ),
    ).toBeUndefined();
  });

  it("ignores deduplicated and out-of-window events for rate limits", () => {
    const trigger = createTrigger({
      maxEventsPerWindow: { maxEvents: 2, windowMs: 5_000 },
    });
    const event = createEvent({ receivedAt: 10_000 });

    expect(
      getSchedulerTriggerRateLimitSkipReason(
        {
          events: [
            createEvent({
              id: "old",
              receivedAt: 4_999,
              matches: [{ triggerId: trigger.id, matched: true }],
            }),
            createEvent({
              id: "deduped",
              receivedAt: 6_000,
              matches: [
                { triggerId: trigger.id, matched: true, deduplicated: true },
              ],
            }),
            createEvent({
              id: "first",
              receivedAt: 7_000,
              matches: [{ triggerId: trigger.id, matched: true }],
            }),
          ],
        },
        trigger,
        event,
      ),
    ).toBeUndefined();

    expect(
      getSchedulerTriggerRateLimitSkipReason(
        {
          events: [
            createEvent({
              id: "first",
              receivedAt: 7_000,
              matches: [{ triggerId: trigger.id, matched: true }],
            }),
            createEvent({
              id: "second",
              receivedAt: 9_000,
              matches: [{ triggerId: trigger.id, matched: true }],
            }),
          ],
        },
        trigger,
        event,
      ),
    ).toContain("2 event(s) per 5000ms");
  });
});

describe("normalizeSchedulerEventPayload", () => {
  it("returns a shallow copy for objects and an empty object for missing input", () => {
    const payload = { value: 1 };

    expect(normalizeSchedulerEventPayload(payload)).toEqual(payload);
    expect(normalizeSchedulerEventPayload(payload)).not.toBe(payload);
    expect(normalizeSchedulerEventPayload(undefined)).toEqual({});
  });
});
