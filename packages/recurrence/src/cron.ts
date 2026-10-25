import type { CalendarRule } from "./contract.ts";
import { RecurrenceError } from "./errors.ts";

const monthNames: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const weekdayNames: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
export interface CronField {
  any: boolean;
  values: ReadonlySet<number>;
  lastDayOfMonth: boolean;
  lastWeekdays: ReadonlySet<number>;
  nearestWeekdays: ReadonlySet<number>;
  nthWeekdays: readonly { day: number; ordinal: number }[];
  lastWeekday: boolean;
}
export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}
function number(
  value: string,
  min: number,
  max: number,
  names: Record<string, number>,
): number {
  const key = value.toLowerCase();
  const named = Object.hasOwn(names, key) ? names[key] : undefined;
  if (named !== undefined) return named;
  if (!/^\d{1,2}$/.test(value))
    throw new RecurrenceError(
      "invalid_recurrence",
      `Invalid cron field value: ${value}`,
    );
  const parsed = Number(value);
  if (parsed < min || parsed > max)
    throw new RecurrenceError(
      "invalid_recurrence",
      `Cron field value out of range: ${value}`,
    );
  return parsed;
}
function field(
  value: string,
  min: number,
  max: number,
  names: Record<string, number> = {},
  kind: "day" | "weekday" | "other" = "other",
): CronField {
  const values = new Set<number>(),
    lastWeekdays = new Set<number>(),
    nearestWeekdays = new Set<number>();
  const nthWeekdays: { day: number; ordinal: number }[] = [];
  let any = false,
    lastDayOfMonth = false,
    lastWeekday = false;
  for (const item of value.split(",")) {
    if (!item)
      throw new RecurrenceError(
        "invalid_recurrence",
        `Invalid cron field: ${value}`,
      );
    if (kind === "day" && item.toUpperCase() === "L") {
      lastDayOfMonth = true;
      continue;
    }
    if (kind === "day" && item.toUpperCase() === "LW") {
      lastWeekday = true;
      continue;
    }
    if (kind === "day" && /^\d{1,2}W$/i.test(item)) {
      nearestWeekdays.add(number(item.slice(0, -1), 1, 31, {}));
      continue;
    }
    if (kind === "weekday" && /^[a-z0-9]+L$/i.test(item)) {
      lastWeekdays.add(number(item.slice(0, -1), min, max, names) % 7);
      continue;
    }
    if (kind === "weekday" && item.includes("#")) {
      const match = /^([a-z0-9]+)#([1-5])$/i.exec(item);
      if (!match)
        throw new RecurrenceError(
          "invalid_recurrence",
          "Use weekday#1 through weekday#5.",
        );
      nthWeekdays.push({
        day: number(match[1]!, min, max, names) % 7,
        ordinal: Number(match[2]),
      });
      continue;
    }
    const parts = item.split("/");
    if (
      parts.length > 2 ||
      (parts.length === 2 && !/^[1-9]\d{0,2}$/.test(parts[1]!))
    )
      throw new RecurrenceError(
        "invalid_recurrence",
        `Invalid cron step: ${item}`,
      );
    const base = parts[0]!,
      step = parts[1] === undefined ? 1 : Number(parts[1]);
    if (base === "*") any ||= parts.length === 1;
    const range =
      base === "*"
        ? [min, max]
        : base.split("-").map((entry) => number(entry, min, max, names));
    if (
      range.length > 2 ||
      !range.length ||
      range[0]! > (range[1] ?? range[0]!)
    )
      throw new RecurrenceError(
        "invalid_recurrence",
        `Invalid cron range: ${item}`,
      );
    const last = range[1] ?? (parts.length === 2 ? max : range[0]!);
    for (let current = range[0]!; current <= last; current += step)
      values.add(kind === "weekday" ? current % 7 : current);
  }
  return {
    any,
    values,
    lastDayOfMonth,
    lastWeekdays,
    nearestWeekdays,
    nthWeekdays,
    lastWeekday,
  };
}
export function parseCronExpression(expression: string): ParsedCronExpression {
  if (expression.length > 256)
    throw new RecurrenceError(
      "invalid_recurrence",
      "Cron expressions cannot exceed 256 characters.",
    );
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new RecurrenceError(
      "invalid_recurrence",
      "Cron schedules must use five fields; seconds are not supported.",
    );
  return {
    minute: field(parts[0]!, 0, 59),
    hour: field(parts[1]!, 0, 23),
    dayOfMonth: field(parts[2]!, 1, 31, {}, "day"),
    month: field(parts[3]!, 1, 12, monthNames),
    dayOfWeek: field(parts[4]!, 0, 7, weekdayNames, "weekday"),
  };
}
export function cronRule(expression: string): CalendarRule {
  const parsed = parseCronExpression(expression);
  const weekdays = [...parsed.dayOfWeek.values].map((day) => ({
    day: day || 7,
    ordinal: null as number | null,
  }));
  weekdays.push(
    ...[...parsed.dayOfWeek.lastWeekdays].map((day) => ({
      day: day || 7,
      ordinal: -1,
    })),
    ...parsed.dayOfWeek.nthWeekdays.map(({ day, ordinal }) => ({
      day: day || 7,
      ordinal,
    })),
  );
  return {
    frequency: "daily",
    interval: 1,
    months: [...parsed.month.values].sort((a, b) => a - b),
    monthDays: parsed.dayOfMonth.any
      ? []
      : [
          ...parsed.dayOfMonth.values,
          ...(parsed.dayOfMonth.lastDayOfMonth ? [-1] : []),
        ].sort((a, b) => a - b),
    weekdays: parsed.dayOfWeek.any
      ? []
      : weekdays.sort(
          (a, b) => a.day - b.day || (a.ordinal ?? 0) - (b.ordinal ?? 0),
        ),
    times: [...parsed.hour.values]
      .flatMap((hour) =>
        [...parsed.minute.values].map((minute) => hour * 60 + minute),
      )
      .sort((a, b) => a - b),
    dayMode: !parsed.dayOfMonth.any && !parsed.dayOfWeek.any ? "or" : "and",
    nearestWeekdays: [...parsed.dayOfMonth.nearestWeekdays],
    lastWeekday: parsed.dayOfMonth.lastWeekday,
    weekStart: 1,
  };
}
