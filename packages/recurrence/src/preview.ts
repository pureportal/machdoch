import type {
  RecurrenceCursor,
  RecurrenceInput,
  RecurrenceOccurrence,
} from "./contract.ts";
import { evaluateRecurrence } from "./evaluate.ts";
import { normalizeRecurrence } from "./normalize.ts";
import { RecurrenceError } from "./errors.ts";

export function previewRecurrence(
  input: RecurrenceInput,
  after: number,
  count = 5,
  fromActivation = false,
) {
  if (!Number.isInteger(count) || count < 1 || count > 20)
    throw new RecurrenceError(
      "invalid_recurrence",
      "Choose between 1 and 20 preview occurrences.",
    );
  const definition = normalizeRecurrence(input),
    occurrences: RecurrenceOccurrence[] = [];
  if (
    fromActivation &&
    definition.kind === "fixed-delay" &&
    definition.start <= after
  ) {
    const result = evaluateRecurrence(definition, {
      after,
      completedAt: after,
      limit: 1,
    });
    return {
      definition,
      occurrences: result.occurrences,
      exhausted: result.exhausted,
      waitingForCompletion: result.waitingForCompletion,
    };
  }
  let cursor: RecurrenceCursor | undefined;
  let exhausted = false,
    waitingForCompletion = false;
  for (let page = 0; page < 120 && occurrences.length < count; page++) {
    const result = evaluateRecurrence(definition, {
      after,
      limit: count - occurrences.length,
      ...(cursor ? { cursor } : {}),
    });
    occurrences.push(...result.occurrences.filter((value) => !value.excluded));
    exhausted = result.exhausted;
    waitingForCompletion = result.waitingForCompletion;
    if (
      result.exhausted ||
      result.windowComplete ||
      result.waitingForCompletion
    )
      return { definition, occurrences, exhausted, waitingForCompletion };
    if (cursor?.after === result.cursor.after)
      throw new RecurrenceError(
        "search_limit",
        "The preview could not advance. Review the recurrence bounds.",
      );
    cursor = result.cursor;
  }
  if (occurrences.length < count)
    throw new RecurrenceError(
      "search_limit",
      "The preview exceeded its accounting limit. Narrow the recurrence range.",
    );
  return { definition, occurrences, exhausted, waitingForCompletion };
}
