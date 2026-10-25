export { recurrenceInputSchema } from "./contract.ts";
export type {
  RecurrenceInput,
  NormalizedRecurrence,
  RecurrenceOccurrence,
  RecurrenceEvaluation,
  RecurrenceCursor,
} from "./contract.ts";
export { normalizeRecurrence } from "./normalize.ts";
export { previewRecurrence } from "./preview.ts";
export { evaluateRecurrence } from "./evaluate.ts";
export type { EvaluationOptions } from "./evaluate.ts";
export { parseCronExpression } from "./cron.ts";
export type { CronField, ParsedCronExpression } from "./cron.ts";
export { timezoneVersion, timezoneIds } from "./time-zone.ts";
export { instantValue as parseRecurrenceInstant } from "./time-zone.ts";
export { RecurrenceError } from "./errors.ts";

import { normalizeRecurrence } from "./normalize.ts";
import { evaluateRecurrence } from "./evaluate.ts";
import { RecurrenceError } from "./errors.ts";

export function getNextCronRunAfter(
  expression: string,
  timezone: string,
  after: number,
): number {
  const definition = normalizeRecurrence({
    kind: "cron",
    expression,
    timezone,
    start: "1970-01-01T00:00:00Z",
  });
  const next = evaluateRecurrence(definition, { after, limit: 1 })
    .occurrences[0];
  if (!next)
    throw new RecurrenceError(
      "no_occurrence",
      "The cron expression has no upcoming occurrence.",
    );
  return next.at;
}
