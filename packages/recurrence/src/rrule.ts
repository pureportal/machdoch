import { LocalDateTime } from "@js-joda/core";
import type { CalendarRuleInput } from "./contract.ts";
import { RecurrenceError } from "./errors.ts";
import { instantValue } from "./time-zone.ts";

const days: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};
function integer(value: string, min: number, max: number): number {
  if (!/^-?\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max)
    throw new RecurrenceError(
      "invalid_recurrence",
      "An RRULE numeric value is out of range.",
    );
  return Number(value);
}
export function parseRRule(
  source: string,
  start: LocalDateTime,
): {
  rule: CalendarRuleInput;
  count: number | null;
  until: number | null;
  weekStart: number;
} {
  if (start.second() !== 0 || start.nano() !== 0)
    throw new RecurrenceError(
      "unsupported_rule",
      "RRULE starts must be on a minute boundary.",
    );
  const parts = new Map<string, string>();
  const allowed = new Set([
    "FREQ",
    "INTERVAL",
    "COUNT",
    "UNTIL",
    "BYMONTH",
    "BYMONTHDAY",
    "BYDAY",
    "BYHOUR",
    "BYMINUTE",
    "WKST",
  ]);
  for (const entry of source
    .replace(/^RRULE:/i, "")
    .toUpperCase()
    .split(";")) {
    const pair = entry.split("=");
    if (pair.length !== 2 || !pair[0] || !pair[1] || parts.has(pair[0]))
      throw new RecurrenceError(
        "invalid_recurrence",
        "Use each RRULE property once with a nonempty value.",
      );
    if (!allowed.has(pair[0]))
      throw new RecurrenceError(
        "unsupported_rule",
        `Unsupported RRULE property: ${pair[0]}`,
      );
    parts.set(pair[0], pair[1]);
  }
  const frequencies = {
    DAILY: "daily",
    WEEKLY: "weekly",
    MONTHLY: "monthly",
    YEARLY: "yearly",
  } as const;
  const frequency = frequencies[parts.get("FREQ") as keyof typeof frequencies];
  if (!frequency)
    throw new RecurrenceError(
      "unsupported_rule",
      "Choose DAILY, WEEKLY, MONTHLY or YEARLY recurrence.",
    );
  if (parts.has("COUNT") && parts.has("UNTIL"))
    throw new RecurrenceError(
      "invalid_recurrence",
      "Use COUNT or UNTIL, not both.",
    );
  const list = (key: string, min: number, max: number) =>
    parts
      .get(key)
      ?.split(",")
      .map((value) => integer(value, min, max));
  const months = list("BYMONTH", 1, 12),
    monthDays = list("BYMONTHDAY", -31, 31);
  if (monthDays?.includes(0))
    throw new RecurrenceError(
      "invalid_recurrence",
      "Month days cannot be zero.",
    );
  const weekdays = parts
    .get("BYDAY")
    ?.split(",")
    .map((value) => {
      const match = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(value);
      if (!match)
        throw new RecurrenceError(
          "unsupported_rule",
          "Use weekday names and monthly ordinals from -5 to 5 in BYDAY.",
        );
      if (
        match[1] &&
        !(frequency === "monthly" || (frequency === "yearly" && months))
      )
        throw new RecurrenceError(
          "unsupported_rule",
          "Ordinal BYDAY requires MONTHLY, or YEARLY with BYMONTH.",
        );
      return {
        day: days[match[2]!]!,
        ...(match[1] ? { ordinal: Number(match[1]) } : {}),
      };
    });
  if (frequency === "weekly" && monthDays)
    throw new RecurrenceError(
      "unsupported_rule",
      "Weekly RRULEs cannot use BYMONTHDAY.",
    );
  const hours = list("BYHOUR", 0, 23) ?? [start.hour()],
    minutes = list("BYMINUTE", 0, 59) ?? [start.minute()];
  let until: number | null = null;
  if (parts.has("UNTIL")) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
      parts.get("UNTIL")!,
    );
    if (!match)
      throw new RecurrenceError(
        "unsupported_rule",
        "Use a UTC UNTIL value in YYYYMMDDTHHMMSSZ format.",
      );
    until = instantValue(
      `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
    );
  }
  const weekStart = parts.has("WKST") ? days[parts.get("WKST")!] : 1;
  if (!weekStart)
    throw new RecurrenceError(
      "invalid_recurrence",
      "Use a weekday name for WKST.",
    );
  return {
    rule: {
      frequency,
      interval: parts.has("INTERVAL")
        ? integer(parts.get("INTERVAL")!, 1, 1000)
        : 1,
      times: hours.flatMap((hour) =>
        minutes.map(
          (minute) =>
            `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        ),
      ),
      ...(months ? { months } : {}),
      ...(monthDays ? { monthDays } : {}),
      ...(weekdays ? { weekdays } : {}),
    },
    count: parts.has("COUNT") ? integer(parts.get("COUNT")!, 1, 100000) : null,
    until,
    weekStart,
  };
}
