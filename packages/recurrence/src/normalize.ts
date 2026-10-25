import { createHash } from "node:crypto";
import type { LocalDateTime } from "@js-joda/core";
import {
  recurrenceInputSchema,
  type CalendarRule,
  type CalendarRuleInput,
  type NormalizedRecurrence,
  type RecurrenceInput,
} from "./contract.ts";
import { cronRule } from "./cron.ts";
import { RecurrenceError } from "./errors.ts";
import { parseRRule } from "./rrule.ts";
import {
  instantValue,
  localAt,
  recurrenceZone,
  timezoneVersion,
} from "./time-zone.ts";

export const uniqueNumbers = (values: number[]): number[] =>
  [...new Set(values)].sort((a, b) => a - b);
type WithoutKey<T> = T extends NormalizedRecurrence ? Omit<T, "key"> : never;
function calendarRule(
  input: CalendarRuleInput,
  anchor: LocalDateTime,
  weekStart = 1,
): CalendarRule {
  if (
    input.weekdays?.some((value) => value.ordinal !== undefined) &&
    !["monthly", "yearly"].includes(input.frequency)
  )
    throw new RecurrenceError(
      "unsupported_rule",
      "Ordinal weekdays require monthly or yearly recurrence.",
    );
  const defaults = !input.monthDays && !input.weekdays;
  const months =
    input.months ??
    (input.frequency === "yearly" && defaults ? [anchor.monthValue()] : []);
  if (
    input.frequency === "yearly" &&
    input.weekdays?.some((value) => value.ordinal !== undefined) &&
    !months.length
  )
    throw new RecurrenceError(
      "unsupported_rule",
      "Yearly ordinal weekdays require a month selection.",
    );
  const weekdays = (
    input.weekdays ??
    (input.frequency === "weekly" ? [{ day: anchor.dayOfWeek().value() }] : [])
  ).map((value) => ({ day: value.day, ordinal: value.ordinal ?? null }));
  const deduplicated = [
    ...new Map(
      weekdays.map((value) => [`${value.day}/${value.ordinal}`, value]),
    ).values(),
  ].sort((a, b) => a.day - b.day || (a.ordinal ?? 0) - (b.ordinal ?? 0));
  return {
    frequency: input.frequency,
    interval: input.interval,
    months: uniqueNumbers(months),
    monthDays: uniqueNumbers(
      input.monthDays ??
        (defaults && ["monthly", "yearly"].includes(input.frequency)
          ? [anchor.dayOfMonth()]
          : []),
    ),
    weekdays: deduplicated,
    times: uniqueNumbers(
      input.times.map(
        (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3)),
      ),
    ),
    dayMode: "and",
    nearestWeekdays: [],
    lastWeekday: false,
    weekStart,
  };
}
export function normalizeRecurrence(
  value: RecurrenceInput,
): NormalizedRecurrence {
  const parsed = recurrenceInputSchema.safeParse(value);
  if (!parsed.success)
    throw new RecurrenceError(
      "invalid_recurrence",
      parsed.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "Schedule"}: ${issue.message}`,
        )
        .join(" "),
    );
  const input = parsed.data;
  const start = instantValue(input.kind === "once" ? input.at : input.start);
  const end =
    input.kind !== "once" && input.end ? instantValue(input.end) : null;
  if (end !== null && end < start)
    throw new RecurrenceError(
      "invalid_recurrence",
      "The schedule end must not precede its start.",
    );
  let definition: WithoutKey<NormalizedRecurrence>;
  if (input.kind === "once")
    definition = { version: 1, kind: "once", start, end: start };
  else if (input.kind === "interval")
    definition = {
      version: 1,
      kind: "interval",
      start,
      end,
      everyMs: input.everyMs,
    };
  else if (input.kind === "fixed-delay")
    definition = {
      version: 1,
      kind: "fixed-delay",
      start,
      end,
      delayMs: input.delayMs,
    };
  else {
    const zone = recurrenceZone(input.timezone),
      anchor = localAt(start, zone);
    let rules: CalendarRule[],
      count: number | null = null,
      generatedUntil: number | null = null;
    if (input.kind === "cron") rules = [cronRule(input.expression)];
    else if (input.kind === "rrule") {
      const rule = parseRRule(input.rule, anchor);
      rules = [calendarRule(rule.rule, anchor, rule.weekStart)];
      count = rule.count;
      generatedUntil = rule.until;
      if (generatedUntil !== null && generatedUntil < start)
        throw new RecurrenceError(
          "invalid_recurrence",
          "UNTIL must not precede the start.",
        );
    } else {
      rules = input.rules.map((rule) => calendarRule(rule, anchor));
      count = input.count ?? null;
    }
    rules = [
      ...new Map(rules.map((rule) => [JSON.stringify(rule), rule])).values(),
    ].sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b)
        ? -1
        : JSON.stringify(a) > JSON.stringify(b)
          ? 1
          : 0,
    );
    definition = {
      version: 1,
      kind: "calendar",
      start,
      end,
      timezone: input.timezone,
      timezoneVersion,
      fold: input.fold,
      gap: input.gap,
      rules,
      count,
      generatedUntil,
      excludeDates: [...new Set(input.excludeDates)].sort(),
      excludeInstants: uniqueNumbers(input.excludeInstants.map(instantValue)),
      rdates:
        input.kind === "rrule"
          ? uniqueNumbers(input.rdates.map(instantValue))
          : [],
      business: input.business
        ? {
            ...input.business,
            workingDays: uniqueNumbers(input.business.workingDays),
            holidays: [...new Set(input.business.holidays)].sort(),
          }
        : null,
    };
  }
  const key = createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex");
  return { ...definition, key };
}
