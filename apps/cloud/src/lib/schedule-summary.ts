import type { RecurrenceInput } from "@machdoch/recurrence";

const units = [
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
] as const;
const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const frequencyNames = {
  daily: ["Daily", "day"],
  weekly: ["Weekly", "week"],
  monthly: ["Monthly", "month"],
  yearly: ["Yearly", "year"],
} as const;

function duration(milliseconds: number): { count: number; unit: string } {
  const [unit, size] =
    units.find(([, length]) => milliseconds % length === 0) ?? units.at(-1)!;
  return { count: Math.max(1, Math.round(milliseconds / size)), unit };
}

export function describeRecurrence(recurrence: RecurrenceInput): string {
  switch (recurrence.kind) {
    case "once":
      return "Once";
    case "interval": {
      const { count, unit } = duration(recurrence.everyMs);
      return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
    }
    case "fixed-delay": {
      const { count, unit } = duration(recurrence.delayMs);
      return `${count} ${unit}${count === 1 ? "" : "s"} after the previous task`;
    }
    case "cron":
      return `Cron ${recurrence.expression}`;
    case "rrule":
      return "Custom recurrence";
    case "calendar": {
      const [rule, ...others] = recurrence.rules;
      const [adverb, noun] = frequencyNames[rule!.frequency];
      const interval = rule!.interval ?? 1;
      const cadence = interval === 1 ? adverb : `Every ${interval} ${noun}s`;
      const days = rule!.weekdays?.length
        ? ` on ${rule!.weekdays.map((entry) => weekdayNames[entry.day - 1]).join(", ")}`
        : "";
      const more = others.length ? ` +${others.length} more` : "";
      return `${cadence}${days} at ${rule!.times.join(", ")}${more}`;
    }
  }
}
