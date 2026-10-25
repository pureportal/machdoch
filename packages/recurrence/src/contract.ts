import { z } from "zod";
import { dateValue, instantValue, recurrenceZone } from "./time-zone.ts";

const instant = z
  .string()
  .max(40)
  .refine((value) => {
    try {
      const result = instantValue(value);
      return (
        Number.isSafeInteger(result) && result >= 0 && result <= 16725225599999
      );
    } catch {
      return false;
    }
  }, "Use an ISO instant between 1970 and 2499.");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      dateValue(value);
      return true;
    } catch {
      return false;
    }
  }, "Use a valid date.");
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekday = z.strictObject({
  day: z.number().int().min(1).max(7),
  ordinal: z
    .number()
    .int()
    .min(-5)
    .max(5)
    .refine((value) => value !== 0)
    .optional(),
});
export const calendarRuleInputSchema = z.strictObject({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(1000).default(1),
  times: z.array(time).min(1).max(1440),
  months: z.array(z.number().int().min(1).max(12)).min(1).max(12).optional(),
  monthDays: z
    .array(
      z
        .number()
        .int()
        .min(-31)
        .max(31)
        .refine((value) => value !== 0),
    )
    .min(1)
    .max(62)
    .optional(),
  weekdays: z.array(weekday).min(1).max(35).optional(),
});
const calendarOptions = {
  start: instant,
  end: instant.optional(),
  timezone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        recurrenceZone(value);
        return true;
      } catch {
        return false;
      }
    }, "Choose an IANA timezone."),
  fold: z.enum(["earlier", "both"]).default("earlier"),
  gap: z.enum(["skip", "shift-forward"]).default("skip"),
  excludeDates: z.array(date).max(3660).default([]),
  excludeInstants: z.array(instant).max(3660).default([]),
  business: z
    .strictObject({
      calendarId: z.string().min(1).max(100),
      revision: z.number().int().positive(),
      workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
      holidays: z.array(date).max(3660),
      policy: z.enum(["skip", "next", "previous"]),
      maxShiftDays: z.number().int().min(1).max(366).default(31),
    })
    .optional(),
};
export const recurrenceInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: instant }),
  z.strictObject({
    kind: z.literal("interval"),
    start: instant,
    end: instant.optional(),
    everyMs: z.number().int().min(1).max(3155760000000),
  }),
  z.strictObject({
    kind: z.literal("fixed-delay"),
    start: instant,
    end: instant.optional(),
    delayMs: z.number().int().min(1).max(3155760000000),
  }),
  z.strictObject({
    kind: z.literal("calendar"),
    ...calendarOptions,
    rules: z.array(calendarRuleInputSchema).min(1).max(16),
    count: z.number().int().min(1).max(100000).optional(),
  }),
  z.strictObject({
    kind: z.literal("cron"),
    ...calendarOptions,
    expression: z.string().trim().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal("rrule"),
    ...calendarOptions,
    rule: z.string().trim().min(1).max(4096),
    rdates: z.array(instant).max(3660).default([]),
  }),
]);
export type RecurrenceInput = z.input<typeof recurrenceInputSchema>;
export type ParsedRecurrenceInput = z.output<typeof recurrenceInputSchema>;
export type CalendarRuleInput = z.output<typeof calendarRuleInputSchema>;
export interface CalendarRule {
  frequency: CalendarRuleInput["frequency"];
  interval: number;
  months: number[];
  monthDays: number[];
  weekdays: { day: number; ordinal: number | null }[];
  times: number[];
  dayMode: "and" | "or";
  nearestWeekdays: number[];
  lastWeekday: boolean;
  weekStart: number;
}
interface DefinitionBase {
  version: 1;
  key: string;
  start: number;
  end: number | null;
}
export type NormalizedRecurrence = DefinitionBase &
  (
    | { kind: "once" }
    | { kind: "interval"; everyMs: number }
    | { kind: "fixed-delay"; delayMs: number }
    | {
        kind: "calendar";
        timezone: string;
        timezoneVersion: string;
        fold: "earlier" | "both";
        gap: "skip" | "shift-forward";
        rules: CalendarRule[];
        count: number | null;
        generatedUntil: number | null;
        excludeDates: string[];
        excludeInstants: number[];
        rdates: number[];
        business:
          | Extract<ParsedRecurrenceInput, { kind: "calendar" }>["business"]
          | null;
      }
  );
export interface RecurrenceOccurrence {
  at: number;
  local: string;
  nominalLocal: string;
  offset: string;
  fold: number;
  shifted: boolean;
  ordinal: number;
  excluded: boolean;
}
export interface RecurrenceCursor {
  key: string;
  after: number;
  ordinal: number;
  generatedCount: number;
}
export interface RecurrenceEvaluation {
  occurrences: RecurrenceOccurrence[];
  cursor: RecurrenceCursor;
  exhausted: boolean;
  windowComplete: boolean;
  waitingForCompletion: boolean;
  evaluatedCandidates: number;
}
