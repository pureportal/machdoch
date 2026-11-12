import type { AutomationTrigger } from "./cloud-automation-contract";

type ScheduleTrigger = Extract<AutomationTrigger, { kind: "schedule" }>;

const minute = 60_000;
const day = 24 * 60 * minute;

function zoneOffset(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const local = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return local - Math.floor(at / 1000) * 1000;
}

function zonedTime(
  year: number,
  month: number,
  date: number,
  hours: number,
  minutes: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month, date, hours, minutes);
  const first = guess - zoneOffset(guess, timeZone);
  const second = guess - zoneOffset(first, timeZone);
  return second === first ? first : second;
}

function localDate(at: number, timeZone: string): Date {
  return new Date(at + zoneOffset(at, timeZone));
}

export function nextScheduledRun(
  trigger: ScheduleTrigger,
  after: number,
): number {
  const [hours, minutes] = trigger.time.split(":").map(Number) as [
    number,
    number,
  ];
  if (trigger.frequency === "hourly") {
    const start = Math.floor(after / minute) * minute;
    const current = localDate(start, trigger.timeZone).getUTCMinutes();
    return start + ((minutes - current + 60) % 60 || 60) * minute;
  }
  const today = localDate(after, trigger.timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + offset,
      ),
    );
    const weekday = date.getUTCDay();
    if (trigger.frequency === "weekdays" && (weekday === 0 || weekday === 6))
      continue;
    if (trigger.frequency === "weekly" && weekday !== trigger.weekday) continue;
    const candidate = zonedTime(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hours,
      minutes,
      trigger.timeZone,
    );
    if (candidate > after) return candidate;
  }
  return after + day;
}
