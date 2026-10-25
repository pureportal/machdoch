import { describe, expect, it } from "vitest";
import {
  evaluateRecurrence,
  getNextCronRunAfter,
  normalizeRecurrence,
  parseCronExpression,
  timezoneVersion,
  type RecurrenceInput,
} from "./index.ts";

const at = (value: string) => Date.parse(value);
function dates(input: RecurrenceInput, after: string, limit = 5) {
  return evaluateRecurrence(normalizeRecurrence(input), {
    after: at(after),
    limit,
  })
    .occurrences.filter((value) => !value.excluded)
    .map((value) => new Date(value.at).toISOString());
}
describe("cron", () => {
  it("shares lists, names, ranges, steps and explicit day OR semantics", () => {
    const parsed = parseCronExpression("*/15 9-17 * jan,mar mon-fri");
    expect([...parsed.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...parsed.dayOfWeek.values]).toEqual([1, 2, 3, 4, 5]);
    expect(
      new Date(
        getNextCronRunAfter("0 9 1 * MON", "UTC", at("2026-10-22T00:00:00Z")),
      ).toISOString(),
    ).toBe("2026-10-26T09:00:00.000Z");
    expect(
      new Date(
        getNextCronRunAfter("0 9 1 * MON", "UTC", at("2026-10-26T09:00:00Z")),
      ).toISOString(),
    ).toBe("2026-11-01T09:00:00.000Z");
    expect([...parseCronExpression("1/15 * * * 5-7").minute.values]).toEqual([
      1, 16, 31, 46,
    ]);
    expect([...parseCronExpression("1/15 * * * 5-7").dayOfWeek.values]).toEqual(
      [5, 6, 0],
    );
  });
  it.each([
    "",
    "0 */5 * * * *",
    "0 9 * * mon,,fri",
    "0/0 9 * * *",
    "60 9 * * *",
    "10-5 9 * * *",
    "0 9 1-2-3 * *",
    "0 9 * * 7-6",
    "*/5/2 * * * *",
    "0 9 * * MON#6",
    "1e1 9 * * *",
    "0 9 * * SUNL/2",
    "constructor 9 * * *",
    "0 9 * __proto__ *",
  ])("rejects invalid grammar %s", (expression) =>
    expect(() => parseCronExpression(expression)).toThrow(),
  );
  it("supports sparse leap days beyond one year and the non-leap century", () => {
    expect(
      new Date(
        getNextCronRunAfter("0 0 29 2 *", "UTC", at("2026-10-22T00:00:00Z")),
      ).toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
    expect(
      new Date(
        getNextCronRunAfter("0 0 29 2 *", "UTC", at("2096-03-01T00:00:00Z")),
      ).toISOString(),
    ).toBe("2104-02-29T00:00:00.000Z");
  });
  it.each([
    ["0 9 L 2 *", "2026-02-28T09:00:00.000Z"],
    ["0 9 LW 2 *", "2026-02-27T09:00:00.000Z"],
    ["0 9 * 2 FRI#2", "2026-02-13T09:00:00.000Z"],
    ["0 9 * 2 7L", "2026-02-22T09:00:00.000Z"],
    ["0 9 1W 3 *", "2026-03-02T09:00:00.000Z"],
  ])("resolves %s", (expression, expected) =>
    expect(
      new Date(
        getNextCronRunAfter(expression, "UTC", at("2026-02-01T00:00:00Z")),
      ).toISOString(),
    ).toBe(expected),
  );
});
describe("timezone and recurrence policy", () => {
  it("pins bundled timezone data rather than the host timezone", () => {
    expect(timezoneVersion).toBe("2026e");
    const before = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      expect(
        new Date(
          getNextCronRunAfter(
            "0 9 * * *",
            "Europe/Berlin",
            at("2026-01-01T00:00:00Z"),
          ),
        ).toISOString(),
      ).toBe("2026-01-01T08:00:00.000Z");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
  it("skips nonexistent local times and supports an explicit gap shift", () => {
    const input = {
      kind: "cron",
      start: "2026-03-28T00:00:00Z",
      timezone: "Europe/Berlin",
      expression: "30 2 * * *",
    } as const;
    expect(dates(input, "2026-03-28T02:00:00Z", 1)).toEqual([
      "2026-03-30T00:30:00.000Z",
    ]);
    expect(
      dates({ ...input, gap: "shift-forward" }, "2026-03-28T02:00:00Z", 1),
    ).toEqual(["2026-03-29T01:30:00.000Z"]);
  });
  it("uses the earlier fold once and orders both-fold occurrences by UTC", () => {
    const input = {
      kind: "cron",
      start: "2026-10-24T00:00:00Z",
      timezone: "Europe/Berlin",
      expression: "0,30 2 * * *",
    } as const;
    expect(dates(input, "2026-10-24T23:00:00Z", 4)).toEqual([
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:00:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
    expect(
      dates({ ...input, fold: "both" }, "2026-10-24T23:00:00Z", 4),
    ).toEqual([
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
    expect(dates(input, "2026-10-25T00:45:00Z", 1)).toEqual([
      "2026-10-26T01:00:00.000Z",
    ]);
  });
  it("handles half-hour folds and a whole skipped date", () => {
    expect(
      dates(
        {
          kind: "cron",
          expression: "45 1 * * *",
          timezone: "Australia/Lord_Howe",
          fold: "both",
          start: "2026-04-03T00:00:00Z",
        },
        "2026-04-04T14:00:00Z",
        2,
      ),
    ).toEqual(["2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"]);
    expect(
      dates(
        {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "Pacific/Apia",
          start: "2011-12-28T00:00:00Z",
        },
        "2011-12-29T20:00:00Z",
        1,
      ),
    ).toEqual(["2011-12-30T19:00:00.000Z"]);
  });
  it("distinguishes an exhausted bounded calendar from a search limit", () => {
    const definition = normalizeRecurrence({
      kind: "cron",
      expression: "0 9 31 2 *",
      timezone: "UTC",
      start: "2026-01-01T00:00:00Z",
      end: "2026-12-31T23:59:00Z",
    });
    expect(
      evaluateRecurrence(definition, { after: at("2026-01-01T00:00:00Z") }),
    ).toMatchObject({ occurrences: [], exhausted: true });
    expect(() =>
      evaluateRecurrence(definition, {
        after: at("2026-01-01T00:00:00Z"),
        maximumDates: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "search_limit" }));
    if (definition.kind === "calendar")
      expect(() =>
        evaluateRecurrence(
          { ...definition, timezoneVersion: "obsolete" },
          { after: definition.start },
        ),
      ).toThrow(expect.objectContaining({ code: "timezone_data_changed" }));
  });
});
describe("calendar inputs", () => {
  it("normalizes structured and RRULE schedules to the same semantic definition", () => {
    const fields = { start: "2026-01-05T09:00:00Z", timezone: "UTC" };
    const structured = normalizeRecurrence({
      kind: "calendar",
      ...fields,
      rules: [
        {
          frequency: "weekly",
          interval: 2,
          times: ["09:00"],
          weekdays: [{ day: 1 }, { day: 3 }],
        },
      ],
    });
    const rrule = normalizeRecurrence({
      kind: "rrule",
      ...fields,
      rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0",
    });
    expect(rrule).toEqual(structured);
  });
  it("supports COUNT before exclusions, RDATE union and durable occurrence cursors", () => {
    const definition = normalizeRecurrence({
      kind: "rrule",
      start: "2026-01-01T09:00:00Z",
      timezone: "UTC",
      rule: "FREQ=DAILY;COUNT=3",
      excludeDates: ["2026-01-02"],
      rdates: ["2026-01-05T09:00:00Z"],
    });
    const first = evaluateRecurrence(definition, {
      after: definition.start - 1,
      limit: 2,
    });
    expect(
      first.occurrences.map((value) => [value.ordinal, value.excluded]),
    ).toEqual([
      [1, false],
      [2, true],
    ]);
    const second = evaluateRecurrence(definition, {
      after: first.cursor.after,
      cursor: first.cursor,
      limit: 5,
    });
    expect(
      second.occurrences.map((value) => new Date(value.at).toISOString()),
    ).toEqual(["2026-01-03T09:00:00.000Z", "2026-01-05T09:00:00.000Z"]);
    expect(second.exhausted).toBe(true);
    expect(second.cursor.generatedCount).toBe(3);
  });
  it("does not restart a finite recurrence when previewing after its count was consumed", () => {
    expect(
      dates(
        {
          kind: "rrule",
          start: "2026-01-01T09:00:00Z",
          timezone: "UTC",
          rule: "FREQ=DAILY;COUNT=3",
        },
        "2026-01-10T00:00:00Z",
      ),
    ).toEqual([]);
  });
  it("keeps future RDATEs live after COUNT ends and a bounded evaluation window closes", () => {
    const definition = normalizeRecurrence({
      kind: "rrule",
      start: "2026-01-01T09:00:00Z",
      timezone: "UTC",
      rule: "FREQ=DAILY;COUNT=1",
      rdates: ["2026-02-01T09:00:00Z"],
    });
    const first = evaluateRecurrence(definition, {
      after: definition.start - 1,
      through: at("2026-01-10T00:00:00Z"),
    });
    expect(first).toMatchObject({ exhausted: false, windowComplete: true });
    const next = evaluateRecurrence(definition, {
      after: first.cursor.after,
      cursor: first.cursor,
    });
    expect(next.occurrences.map((value) => value.at)).toEqual([
      at("2026-02-01T09:00:00Z"),
    ]);
    expect(next.exhausted).toBe(true);
  });
  it("jumps sparse monthly intervals without scanning every intervening day", () => {
    expect(
      dates(
        {
          kind: "rrule",
          start: "2026-01-31T09:00:00Z",
          timezone: "UTC",
          rule: "FREQ=MONTHLY;INTERVAL=1000;COUNT=2",
        },
        "2026-02-01T00:00:00Z",
        1,
      ),
    ).toEqual(["2109-05-31T09:00:00.000Z"]);
  });
  it("applies UNTIL only to generated dates while retaining later explicit dates", () => {
    const definition = normalizeRecurrence({
      kind: "rrule",
      start: "2026-01-01T09:00:00Z",
      timezone: "UTC",
      rule: "FREQ=DAILY;UNTIL=20260102T090000Z",
      rdates: ["2026-02-01T09:00:00Z"],
    });
    const first = evaluateRecurrence(definition, {
      after: definition.start - 1,
      through: at("2026-01-10T00:00:00Z"),
    });
    expect(first.occurrences.map((value) => value.at)).toEqual([
      definition.start,
      at("2026-01-02T09:00:00Z"),
    ]);
    expect(first).toMatchObject({ windowComplete: true, exhausted: false });
    const second = evaluateRecurrence(definition, {
      after: first.cursor.after,
      cursor: first.cursor,
    });
    expect(second.occurrences.map((value) => value.at)).toEqual([
      at("2026-02-01T09:00:00Z"),
    ]);
    expect(second.exhausted).toBe(true);
    const bounded = normalizeRecurrence({
      kind: "rrule",
      start: "2026-01-01T09:00:00Z",
      end: "2026-01-31T23:00:00Z",
      timezone: "UTC",
      rule: "FREQ=DAILY;UNTIL=20260102T090000Z",
      rdates: ["2026-02-01T09:00:00Z"],
    });
    expect(
      evaluateRecurrence(bounded, { after: at("2026-01-10T00:00:00Z") }),
    ).toMatchObject({ occurrences: [], exhausted: true });
  });
  it("skips invalid month days and resolves yearly/monthly ordinal weekdays", () => {
    expect(
      dates(
        {
          kind: "rrule",
          start: "2026-01-31T09:00:00Z",
          timezone: "UTC",
          rule: "FREQ=MONTHLY;COUNT=3",
        },
        "2026-01-01T00:00:00Z",
        3,
      ),
    ).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
    ]);
    expect(
      dates(
        {
          kind: "rrule",
          start: "2026-01-01T09:00:00Z",
          timezone: "UTC",
          rule: "FREQ=YEARLY;BYMONTH=5;BYDAY=-1MO;COUNT=2",
        },
        "2026-01-01T00:00:00Z",
        2,
      ),
    ).toEqual(["2026-05-25T09:00:00.000Z", "2027-05-31T09:00:00.000Z"]);
  });
  it.each([
    "FREQ=SECONDLY",
    "FREQ=DAILY;BYSECOND=3",
    "FREQ=DAILY;INTERVAL=1;INTERVAL=2",
    "FREQ=DAILY;COUNT=3;UNTIL=20260110T000000Z",
    "FREQ=YEARLY;BYDAY=1MO",
    "FREQ=WEEKLY;BYMONTHDAY=1",
    "FREQ=DAILY;BYDAY=",
    "FREQ=DAILY;BYSETPOS=1",
  ])("rejects unsupported or ambiguous RRULE syntax %s", (rule) => {
    expect(() =>
      normalizeRecurrence({
        kind: "rrule",
        start: "2026-01-01T00:00:00Z",
        timezone: "UTC",
        rule,
      }),
    ).toThrow();
  });
  it("deduplicates overlapping rules and shifted occurrences", () => {
    const definition = normalizeRecurrence({
      kind: "calendar",
      start: "2026-01-02T00:00:00Z",
      timezone: "UTC",
      rules: [
        { frequency: "daily", times: ["09:00", "09:00"] },
        { frequency: "weekly", weekdays: [{ day: 1 }], times: ["09:00"] },
      ],
      business: {
        calendarId: "work",
        revision: 1,
        workingDays: [1, 2, 3, 4, 5],
        holidays: [],
        policy: "next",
        maxShiftDays: 7,
      },
    });
    expect(
      evaluateRecurrence(definition, {
        after: at("2026-01-02T10:00:00Z"),
        limit: 3,
      }).occurrences.map((value) => new Date(value.at).toISOString()),
    ).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-06T09:00:00.000Z",
      "2026-01-07T09:00:00.000Z",
    ]);
  });
  it("keeps previous-business-day shifts ordered and pins supplied holidays", () => {
    const input: RecurrenceInput = {
      kind: "calendar",
      start: "2026-01-01T00:00:00Z",
      timezone: "UTC",
      rules: [{ frequency: "daily", times: ["09:00"] }],
      business: {
        calendarId: "work",
        revision: 2,
        workingDays: [1, 2, 3, 4, 5],
        holidays: ["2026-01-05"],
        policy: "previous",
        maxShiftDays: 7,
      },
    };
    expect(dates(input, "2026-01-01T10:00:00Z", 3)).toEqual([
      "2026-01-02T09:00:00.000Z",
      "2026-01-06T09:00:00.000Z",
      "2026-01-07T09:00:00.000Z",
    ]);
    expect(normalizeRecurrence(input).key).not.toBe(
      normalizeRecurrence({
        ...input,
        business: { ...input.business!, revision: 3 },
      }).key,
    );
  });
});
describe("elapsed-time schedules", () => {
  it("advances old interval cursors arithmetically across long downtime", () => {
    const definition = normalizeRecurrence({
      kind: "interval",
      start: "1970-01-01T00:00:00Z",
      everyMs: 1,
    });
    const first = evaluateRecurrence(definition, { after: -1, limit: 1 });
    const after = at("2026-01-01T00:00:00Z");
    const next = evaluateRecurrence(definition, {
      after,
      cursor: first.cursor,
      limit: 1,
    });
    expect(next.evaluatedCandidates).toBe(1);
    expect(next.occurrences[0]).toMatchObject({
      at: after + 1,
      ordinal: after + 2,
    });
  });
  it("keeps interval anchors and once-only boundaries", () => {
    expect(
      dates(
        { kind: "interval", start: "2026-03-29T00:00:00Z", everyMs: 3600000 },
        "2026-03-29T00:00:30Z",
        3,
      ),
    ).toEqual([
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T02:00:00.000Z",
      "2026-03-29T03:00:00.000Z",
    ]);
    const once = normalizeRecurrence({
      kind: "once",
      at: "2026-03-29T00:00:00Z",
    });
    expect(
      evaluateRecurrence(once, { after: once.start - 1 }).occurrences,
    ).toHaveLength(1);
    expect(evaluateRecurrence(once, { after: once.start })).toMatchObject({
      occurrences: [],
      exhausted: true,
    });
  });
  it("calculates fixed delay only from a terminal timestamp", () => {
    const definition = normalizeRecurrence({
      kind: "fixed-delay",
      start: "2026-01-01T00:00:00Z",
      delayMs: 60000,
    });
    const first = evaluateRecurrence(definition, {
      after: definition.start - 1,
    });
    expect(first.occurrences).toHaveLength(1);
    expect(first.waitingForCompletion).toBe(true);
    expect(
      evaluateRecurrence(definition, {
        after: first.cursor.after,
        cursor: first.cursor,
      }).occurrences,
    ).toHaveLength(0);
    const completedAt = at("2026-01-01T01:00:00Z");
    expect(
      evaluateRecurrence(definition, {
        after: first.cursor.after,
        cursor: first.cursor,
        completedAt,
      }).occurrences[0]?.at,
    ).toBe(completedAt + 60000);
    expect(() =>
      evaluateRecurrence(definition, {
        after: first.cursor.after,
        cursor: first.cursor,
        completedAt: definition.start - 1,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_recurrence" }));
  });
});
