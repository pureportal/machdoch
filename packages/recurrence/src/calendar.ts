import { ChronoUnit, LocalDate, LocalDateTime } from "@js-joda/core";
import type { CalendarRule, NormalizedRecurrence } from "./contract.ts";
import { RecurrenceError } from "./errors.ts";

type CalendarDefinition = Extract<NormalizedRecurrence, { kind: "calendar" }>;
export function ruleMonthMatches(
  rule: CalendarRule,
  date: LocalDate,
  anchor: LocalDate,
): boolean {
  if (rule.months.length && !rule.months.includes(date.monthValue()))
    return false;
  if (rule.frequency === "monthly") {
    const months =
      (date.year() - anchor.year()) * 12 +
      date.monthValue() -
      anchor.monthValue();
    return months >= 0 && months % rule.interval === 0;
  }
  if (rule.frequency === "yearly") {
    const years = date.year() - anchor.year();
    return years >= 0 && years % rule.interval === 0;
  }
  return true;
}
export function ruleDateMatches(
  rule: CalendarRule,
  date: LocalDate,
  anchor: LocalDate,
): boolean {
  if (!ruleMonthMatches(rule, date, anchor)) return false;
  const day = date.dayOfMonth(),
    length = date.lengthOfMonth(),
    weekday = date.dayOfWeek().value();
  let period: number;
  if (rule.frequency === "daily")
    period = ChronoUnit.DAYS.between(anchor, date);
  else if (rule.frequency === "weekly") {
    const startWeek = anchor.minusDays(
      (anchor.dayOfWeek().value() - rule.weekStart + 7) % 7,
    );
    const dateWeek = date.minusDays((weekday - rule.weekStart + 7) % 7);
    period = ChronoUnit.WEEKS.between(startWeek, dateWeek);
  } else period = 0;
  if (period < 0 || period % rule.interval !== 0) return false;
  const monthRestricted =
    rule.monthDays.length > 0 ||
    rule.nearestWeekdays.length > 0 ||
    rule.lastWeekday;
  const weekdayRestricted = rule.weekdays.length > 0;
  const monthMatch =
    !monthRestricted ||
    rule.monthDays.some(
      (value) => (value > 0 ? value : length + value + 1) === day,
    ) ||
    rule.nearestWeekdays.some((value) => {
      if (value > length) return false;
      const selected = date.withDayOfMonth(value),
        week = selected.dayOfWeek().value();
      const adjusted =
        week === 6
          ? value === 1
            ? 3
            : value - 1
          : week === 7
            ? value === length
              ? value - 2
              : value + 1
            : value;
      return adjusted === day;
    }) ||
    (rule.lastWeekday &&
      weekday <= 5 &&
      (day === length || (weekday === 5 && day >= length - 2)));
  const weekMatch =
    !weekdayRestricted ||
    rule.weekdays.some(
      (value) =>
        value.day === weekday &&
        (value.ordinal === null ||
          (value.ordinal > 0
            ? Math.floor((day - 1) / 7) + 1
            : -Math.floor((length - day) / 7) - 1) === value.ordinal),
    );
  return rule.dayMode === "or" && monthRestricted && weekdayRestricted
    ? monthMatch || weekMatch
    : monthMatch && weekMatch;
}
export function nextPossibleDate(
  rule: CalendarRule,
  date: LocalDate,
  anchor: LocalDate,
): LocalDate {
  if (rule.frequency === "daily")
    return anchor.plusDays(
      (Math.floor(ChronoUnit.DAYS.between(anchor, date) / rule.interval) + 1) *
        rule.interval,
    );
  if (rule.frequency === "weekly") {
    const startWeek = anchor.minusDays(
      (anchor.dayOfWeek().value() - rule.weekStart + 7) % 7,
    );
    const weeks = Math.floor(ChronoUnit.DAYS.between(startWeek, date) / 7);
    if (
      weeks % rule.interval === 0 &&
      (date.dayOfWeek().value() - rule.weekStart + 7) % 7 !== 6
    )
      return date.plusDays(1);
    return startWeek.plusWeeks(
      (Math.floor(weeks / rule.interval) + 1) * rule.interval,
    );
  }
  if (rule.frequency === "monthly") {
    const months =
      (date.year() - anchor.year()) * 12 +
      date.monthValue() -
      anchor.monthValue();
    if (
      months % rule.interval === 0 &&
      date.dayOfMonth() < date.lengthOfMonth()
    )
      return date.plusDays(1);
    return anchor
      .withDayOfMonth(1)
      .plusMonths((Math.floor(months / rule.interval) + 1) * rule.interval);
  }
  const years = date.year() - anchor.year();
  if (years % rule.interval === 0 && date.dayOfYear() < date.lengthOfYear())
    return date.plusDays(1);
  return LocalDate.of(
    anchor.year() + (Math.floor(years / rule.interval) + 1) * rule.interval,
    1,
    1,
  );
}
export function businessDate(
  date: LocalDate,
  definition: CalendarDefinition,
  holidays: ReadonlySet<string>,
): LocalDate | null {
  const calendar = definition.business;
  if (!calendar) return date;
  const isWorking = (candidate: LocalDate) =>
    calendar.workingDays.includes(candidate.dayOfWeek().value()) &&
    !holidays.has(candidate.toString());
  if (isWorking(date)) return date;
  if (calendar.policy === "skip") return null;
  for (let distance = 1; distance <= calendar.maxShiftDays; distance++) {
    const candidate = date.plusDays(
      calendar.policy === "next" ? distance : -distance,
    );
    if (isWorking(candidate)) return candidate;
  }
  throw new RecurrenceError(
    "calendar_limit",
    "No working day was found within the calendar's shift limit. Review the calendar or increase its limit.",
  );
}
export function civilTime(date: LocalDate, minute: number): LocalDateTime {
  return LocalDateTime.of(
    date.year(),
    date.monthValue(),
    date.dayOfMonth(),
    Math.floor(minute / 60),
    minute % 60,
  );
}
