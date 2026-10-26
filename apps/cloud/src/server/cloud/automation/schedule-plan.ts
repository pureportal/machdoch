import {
  evaluateRecurrence,
  normalizeRecurrence,
  previewRecurrence,
  RecurrenceError,
  type RecurrenceCursor,
  type RecurrenceInput,
  type NormalizedRecurrence,
} from "@machdoch/recurrence";
import type { ScheduleInput } from "../../../lib/cloud-schedule-contract";

export interface SchedulePlanInput {
  recurrence: RecurrenceInput;
  definitionKey: string;
  nextAt: number;
  now: number;
  missed: ScheduleInput["missed"];
  catchUpLimit: number;
  lookbackHours: number;
}
export interface SchedulePlan {
  due: number[];
  accountedThrough: number;
  nextAt: number | null;
  fixedDelay?: Extract<NormalizedRecurrence, { kind: "fixed-delay" }>;
}

export function nextAfterCompletion(
  definition: Extract<NormalizedRecurrence, { kind: "fixed-delay" }>,
  completedAt: number,
): number | null {
  return (
    evaluateRecurrence(definition, {
      after: completedAt,
      completedAt,
      limit: 1,
    }).occurrences[0]?.at ?? null
  );
}

export function planSchedule(input: SchedulePlanInput): SchedulePlan {
  const definition = normalizeRecurrence(input.recurrence);
  if (definition.key !== input.definitionKey)
    throw new RecurrenceError(
      "timezone_data_changed",
      "The schedule's timezone rules changed. Preview its dates and enable it again.",
    );
  if (
    (definition.kind === "fixed-delay" && definition.delayMs < 60_000) ||
    (definition.kind === "interval" && definition.everyMs < 60_000)
  )
    throw new RecurrenceError(
      "invalid_recurrence",
      "Use a calendar rule, one time, or an interval or delay of at least one minute.",
    );
  if (input.now < input.nextAt)
    return {
      due: [],
      accountedThrough: input.nextAt - 1,
      nextAt: input.nextAt,
    };
  const after = Math.max(
    input.nextAt - 1,
    input.now -
      (input.missed === "skip" ? 60_000 : input.lookbackHours * 3_600_000),
  );
  if (definition.kind === "fixed-delay")
    return {
      due: input.nextAt > after ? [input.nextAt] : [],
      accountedThrough: input.now,
      nextAt: null,
      fixedDelay: definition,
    };
  let cursor: RecurrenceCursor | undefined;
  let complete = false;
  const due: number[] = [];
  for (let page = 0; page < 150; page++) {
    const result = evaluateRecurrence(definition, {
      after,
      through: input.now,
      cursor,
      limit: 100,
    });
    for (const occurrence of result.occurrences) {
      if (occurrence.excluded) continue;
      due.push(occurrence.at);
      const limit = input.missed === "latest" ? 1 : input.catchUpLimit;
      if (due.length > limit) due.shift();
    }
    cursor = result.cursor;
    if (result.exhausted || result.windowComplete) {
      complete = true;
      break;
    }
  }
  if (!complete)
    throw new RecurrenceError(
      "search_limit",
      "The missed schedule window is too large. Shorten the lookback and resume the schedule.",
    );
  const next = previewRecurrence(input.recurrence, input.now, 1).occurrences[0];
  return { due, accountedThrough: input.now, nextAt: next?.at ?? null };
}
