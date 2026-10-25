import { expect, it } from "vitest";
import {
  normalizeRecurrence,
  previewRecurrence,
  evaluateRecurrence,
} from "./index.ts";

it.each([
  ["MO", [5, 10, 19, 24]],
  ["SU", [5, 17, 19, 31]],
] as const)(
  "matches the RFC weekly example with WKST=%s",
  (weekStart, days) => {
    const preview = previewRecurrence(
      {
        kind: "rrule",
        start: "1997-08-05T13:00:00Z",
        timezone: "America/New_York",
        rule: `FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${weekStart}`,
      },
      Date.parse("1997-08-05T00:00:00Z"),
      4,
    );
    expect(
      preview.occurrences.map((value) => new Date(value.at).toISOString()),
    ).toEqual(
      days.map(
        (day) => `1997-08-${String(day).padStart(2, "0")}T13:00:00.000Z`,
      ),
    );
  },
);

it("skips invalid month days without consuming COUNT and keeps local time across DST", () => {
  const preview = previewRecurrence(
    {
      kind: "rrule",
      start: "2007-01-15T14:00:00Z",
      timezone: "America/New_York",
      rule: "FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5",
    },
    Date.parse("2007-01-01T00:00:00Z"),
    5,
  );
  expect(
    preview.occurrences.map((value) => new Date(value.at).toISOString()),
  ).toEqual([
    "2007-01-15T14:00:00.000Z",
    "2007-01-30T14:00:00.000Z",
    "2007-02-15T14:00:00.000Z",
    "2007-03-15T13:00:00.000Z",
    "2007-03-30T13:00:00.000Z",
  ]);
});

it("normalizes offset timestamps and rejects impossible calendar instants", () => {
  expect(
    normalizeRecurrence({ kind: "once", at: "2026-10-24T10:00:00+02:00" }),
  ).toEqual(normalizeRecurrence({ kind: "once", at: "2026-10-24T08:00:00Z" }));
  expect(() =>
    normalizeRecurrence({ kind: "once", at: "2026-02-31T08:00:00Z" }),
  ).toThrow();
});

it("respects a new start boundary when continuing after an earlier task", () => {
  const definition = normalizeRecurrence({
    kind: "fixed-delay",
    start: "2026-10-24T10:00:00Z",
    delayMs: 60000,
  });
  for (const [completed, expected] of [
    ["2026-10-24T09:00:00Z", "2026-10-24T10:00:00Z"],
    ["2026-10-24T09:59:45Z", "2026-10-24T10:00:45Z"],
  ]) {
    const completedAt = Date.parse(completed!);
    expect(
      evaluateRecurrence(definition, { after: completedAt, completedAt })
        .occurrences[0]?.at,
    ).toBe(Date.parse(expected!));
  }
});

it("previews a prospective fixed-delay activation without inventing later completion times", () => {
  const recurrence = {
    kind: "fixed-delay" as const,
    start: "2026-01-01T00:00:00Z",
    delayMs: 60000,
  };
  const after = Date.parse("2026-10-24T12:00:00Z");
  expect(previewRecurrence(recurrence, after, 5).occurrences).toHaveLength(0);
  const result = previewRecurrence(recurrence, after, 5, true);
  expect(result.occurrences.map((entry) => entry.at)).toEqual([after + 60000]);
  expect(result.waitingForCompletion).toBe(true);
});
