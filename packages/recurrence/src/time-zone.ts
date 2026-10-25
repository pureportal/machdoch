import {
  Instant,
  LocalDate,
  LocalDateTime,
  ZoneId,
  ZoneRulesProvider,
  ZonedDateTime,
} from "@js-joda/core";
import "@js-joda/timezone";
import { RecurrenceError } from "./errors.ts";

const provider = ZoneRulesProvider as typeof ZoneRulesProvider & {
  getTzdbData(): { version: string };
};
export const timezoneVersion = provider.getTzdbData().version;
export const timezoneIds = Object.freeze(
  [...ZoneRulesProvider.getAvailableZoneIds()].sort(),
);
const knownZones = new Set(timezoneIds);
export const calendarFirstYear = 1969;
export const calendarLastYear = 2499;

export function recurrenceZone(name: string): ZoneId {
  if (!knownZones.has(name))
    throw new RecurrenceError("invalid_timezone", "Choose an IANA timezone.");
  if (provider.getTzdbData().version !== timezoneVersion)
    throw new RecurrenceError(
      "timezone_data_changed",
      "Timezone rules changed. Review the schedule before continuing.",
    );
  return ZoneId.of(name);
}
export function localAt(timestamp: number, zone: ZoneId): LocalDateTime {
  return ZonedDateTime.ofInstant(
    Instant.ofEpochMilli(timestamp),
    zone,
  ).toLocalDateTime();
}
export function instantValue(value: string): number {
  try {
    return Instant.parse(value).toEpochMilli();
  } catch {
    throw new RecurrenceError(
      "invalid_recurrence",
      "Use a valid ISO date and time with an offset.",
    );
  }
}
export function dateValue(value: string): LocalDate {
  try {
    return LocalDate.parse(value);
  } catch {
    throw new RecurrenceError(
      "invalid_recurrence",
      "Use a valid calendar date.",
    );
  }
}
export function resolveLocal(
  local: LocalDateTime,
  zone: ZoneId,
  fold: "earlier" | "both",
  gap: "skip" | "shift-forward",
): { at: number; fold: number; shifted: boolean }[] {
  if (local.year() < calendarFirstYear || local.year() > calendarLastYear)
    throw new RecurrenceError(
      "search_limit",
      "The date is outside the bundled timezone-data horizon.",
    );
  const rules = zone.rules();
  const offsets = rules.validOffsets(local);
  if (!offsets.length) {
    if (gap === "skip") return [];
    const transition = rules.transition(local);
    const shifted = local.plusSeconds(transition.duration().seconds());
    return [
      {
        at: shifted.toEpochSecond(transition.offsetAfter()) * 1000,
        fold: 0,
        shifted: true,
      },
    ];
  }
  const resolved = offsets
    .map((offset) => local.toEpochSecond(offset) * 1000)
    .sort((a, b) => a - b);
  return (fold === "both" ? resolved : resolved.slice(0, 1)).map(
    (at, index) => ({ at, fold: index, shifted: false }),
  );
}
