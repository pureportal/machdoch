import {
  getNextCronRunAfter,
  parseCronExpression,
} from "./parse-cron-expression.helper.ts";

describe("parseCronExpression", () => {
  it("parses lists, ranges, steps, and named fields", () => {
    const parsed = parseCronExpression("*/15 9-17 * jan,mar mon-fri");

    expect([...parsed.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hour.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parsed.month.values]).toEqual([1, 3]);
    expect([...parsed.dayOfWeek.values]).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.dayOfMonth.any).toBe(true);
  });

  it("parses last day-of-month and last weekday markers", () => {
    const parsed = parseCronExpression("0 9 L * 7L");

    expect(parsed.dayOfMonth.lastDayOfMonth).toBe(true);
    expect([...parsed.dayOfWeek.lastWeekdays]).toEqual([0]);
  });

  it.each([
    ["", /five fields/u],
    ["   ", /five fields/u],
    ["0 */5 * * * *", /five fields/u],
    ["0 9 * * mon,,fri", /Invalid cron field/u],
    ["0/0 9 * * *", /Invalid cron step/u],
    ["60 9 * * *", /out of range/u],
    ["10-5 9 * * *", /Invalid cron range/u],
    ["nope 9 * * *", /Invalid cron field value/u],
  ])("rejects invalid cron expression %j", (expression, expectedError) => {
    expect(() => parseCronExpression(expression)).toThrow(expectedError);
  });
});

describe("getNextCronRunAfter", () => {
  it("rounds up to the next minute boundary", () => {
    const after = Date.UTC(2026, 0, 1, 0, 0, 30);
    const next = getNextCronRunAfter("* * * * *", "UTC", after);

    expect(new Date(next).toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("uses OR semantics when day-of-month and day-of-week are both restricted", () => {
    const after = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = getNextCronRunAfter("0 9 15 * mon", "UTC", after);

    expect(new Date(next).toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("handles leap-year last day-of-month schedules", () => {
    const after = Date.UTC(2028, 1, 28, 9, 0, 0);
    const next = getNextCronRunAfter("0 9 L 2 *", "UTC", after);

    expect(new Date(next).toISOString()).toBe("2028-02-29T09:00:00.000Z");
  });

  it("handles named last weekday schedules", () => {
    const after = Date.UTC(2026, 5, 1, 0, 0, 0);
    const next = getNextCronRunAfter("0 9 * * friL", "UTC", after);

    expect(new Date(next).toISOString()).toBe("2026-06-26T09:00:00.000Z");
  });

  it("calculates runs in the configured IANA timezone", () => {
    const after = Date.UTC(2026, 0, 1, 13, 59, 0);
    const next = getNextCronRunAfter("0 9 * * *", "America/New_York", after);

    expect(new Date(next).toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });

  it("rejects invalid timezones", () => {
    const after = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(() => getNextCronRunAfter("* * * * *", "Not/A_Timezone", after)).toThrow(
      RangeError,
    );
  });
});
