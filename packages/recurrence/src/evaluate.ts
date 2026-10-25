import { Instant, ZoneOffset, ZonedDateTime } from "@js-joda/core";
import type {
  NormalizedRecurrence,
  RecurrenceCursor,
  RecurrenceEvaluation,
  RecurrenceOccurrence,
} from "./contract.ts";
import {
  businessDate,
  civilTime,
  nextPossibleDate,
  ruleDateMatches,
  ruleMonthMatches,
} from "./calendar.ts";
import { RecurrenceError } from "./errors.ts";
import {
  localAt,
  recurrenceZone,
  resolveLocal,
  timezoneVersion,
} from "./time-zone.ts";

const maximumInstant = 16725225599999;
export interface EvaluationOptions {
  after: number;
  limit?: number;
  through?: number;
  cursor?: RecurrenceCursor;
  completedAt?: number;
  maximumCandidates?: number;
  maximumDates?: number;
}
interface Candidate extends Omit<RecurrenceOccurrence, "ordinal"> {
  generated: boolean;
  explicit: boolean;
}

export function evaluateRecurrence(
  definition: NormalizedRecurrence,
  options: EvaluationOptions,
): RecurrenceEvaluation {
  const limit = options.limit ?? 10;
  if (
    !Number.isSafeInteger(options.after) ||
    options.after < -1 ||
    options.after > maximumInstant ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new RecurrenceError(
      "invalid_recurrence",
      "Choose a valid preview instant and between 1 and 100 occurrences.",
    );
  if (
    definition.version !== 1 ||
    (options.cursor && options.cursor.key !== definition.key)
  )
    throw new RecurrenceError(
      "invalid_recurrence",
      "The occurrence cursor belongs to a different schedule.",
    );
  const cursor: RecurrenceCursor = options.cursor
    ? { ...options.cursor }
    : {
        key: definition.key,
        after:
          definition.kind === "calendar" && definition.count !== null
            ? definition.start - 1
            : Math.max(options.after, definition.start - 1),
        ordinal: 0,
        generatedCount: 0,
      };
  if (
    ![cursor.after, cursor.ordinal, cursor.generatedCount].every(
      Number.isSafeInteger,
    ) ||
    cursor.after < -1 ||
    cursor.ordinal < 0 ||
    cursor.generatedCount < 0
  )
    throw new RecurrenceError(
      "invalid_recurrence",
      "The occurrence cursor is invalid.",
    );
  const horizon = Math.min(
    definition.end ?? maximumInstant,
    options.through ?? maximumInstant,
  );
  if (
    !Number.isSafeInteger(horizon) ||
    horizon < -1 ||
    horizon > maximumInstant
  )
    throw new RecurrenceError(
      "invalid_recurrence",
      "Choose a valid preview end.",
    );
  const occurrences: RecurrenceOccurrence[] = [];
  const result: RecurrenceEvaluation = {
    occurrences,
    cursor,
    exhausted: false,
    windowComplete: false,
    waitingForCompletion: false,
    evaluatedCandidates: 0,
  };
  if (cursor.after >= horizon) {
    result.exhausted =
      definition.end !== null && cursor.after >= definition.end;
    result.windowComplete = true;
    return result;
  }
  function timeline(at: number) {
    cursor.after = at;
    cursor.ordinal++;
    cursor.generatedCount++;
    if (at > options.after)
      occurrences.push({
        at,
        local: new Date(at).toISOString().slice(0, -1),
        nominalLocal: new Date(at).toISOString().slice(0, -1),
        offset: "Z",
        fold: 0,
        shifted: false,
        ordinal: cursor.ordinal,
        excluded: false,
      });
  }
  if (definition.kind === "once") {
    if (definition.start > cursor.after && definition.start <= horizon)
      timeline(definition.start);
    result.exhausted = cursor.after >= definition.start;
    result.windowComplete = true;
    return result;
  }
  if (definition.kind === "fixed-delay") {
    if (
      options.completedAt !== undefined &&
      (!Number.isSafeInteger(options.completedAt) ||
        options.completedAt < 0 ||
        options.completedAt > maximumInstant ||
        (options.cursor &&
          cursor.ordinal > 0 &&
          options.completedAt < cursor.after))
    )
      throw new RecurrenceError(
        "invalid_recurrence",
        "The previous completion must follow its scheduled occurrence within the supported date range.",
      );
    const at =
      options.completedAt === undefined
        ? definition.start
        : Math.max(definition.start, options.completedAt + definition.delayMs);
    if (at > cursor.after && at <= horizon) timeline(at);
    result.exhausted = definition.end !== null && at > definition.end;
    result.waitingForCompletion = !result.exhausted;
    result.windowComplete = true;
    return result;
  }
  if (definition.kind === "interval") {
    let index = Math.max(
      0,
      Math.floor(
        (Math.max(cursor.after, options.after) - definition.start) /
          definition.everyMs,
      ) + 1,
    );
    cursor.ordinal = index;
    cursor.generatedCount = index;
    while (occurrences.length < limit) {
      const at = definition.start + index * definition.everyMs;
      if (at > horizon) {
        result.exhausted = definition.end !== null && at > definition.end;
        result.windowComplete = true;
        cursor.after = Math.max(cursor.after, horizon);
        break;
      }
      timeline(at);
      index++;
      result.evaluatedCandidates++;
    }
    return result;
  }
  if (definition.timezoneVersion !== timezoneVersion)
    throw new RecurrenceError(
      "timezone_data_changed",
      "Timezone rules changed. Review this schedule before continuing.",
    );
  const zone = recurrenceZone(definition.timezone),
    anchor = localAt(definition.start, zone);
  const forward =
    definition.business?.policy === "next"
      ? definition.business.maxShiftDays
      : 0;
  const backward =
    definition.business?.policy === "previous"
      ? definition.business.maxShiftDays
      : 0;
  const maximumDates = options.maximumDates ?? 20000,
    maximumCandidates = options.maximumCandidates ?? 200000;
  if (
    !Number.isSafeInteger(maximumDates) ||
    maximumDates < 1 ||
    maximumDates > 200000 ||
    !Number.isSafeInteger(maximumCandidates) ||
    maximumCandidates < 1 ||
    maximumCandidates > 2000000
  )
    throw new RecurrenceError(
      "invalid_recurrence",
      "The recurrence evaluation budget is invalid.",
    );
  const startAfter = cursor.after;
  let day = localAt(Math.max(startAfter, definition.start), zone)
    .toLocalDate()
    .minusDays(forward + 2);
  if (day.isBefore(anchor.toLocalDate())) day = anchor.toLocalDate();
  const generatedHorizon = Math.min(
    horizon,
    definition.generatedUntil ?? horizon,
  );
  const lastDate = localAt(generatedHorizon, zone)
    .toLocalDate()
    .plusDays(backward + 1);
  const excludedDates = new Set(definition.excludeDates),
    excludedInstants = new Set(definition.excludeInstants),
    holidays = new Set(definition.business?.holidays ?? []);
  const pending = new Map<number, Candidate>();
  const countLimit = definition.count;
  let dates = 0,
    accounted = 0;
  function add(candidate: Candidate) {
    if (
      candidate.at <= startAfter ||
      candidate.at < definition.start ||
      candidate.at > horizon ||
      (!candidate.explicit && candidate.at > generatedHorizon)
    )
      return;
    const previous = pending.get(candidate.at);
    if (!previous) pending.set(candidate.at, candidate);
    else {
      const chosen =
        (!candidate.excluded && previous.excluded) ||
        (candidate.excluded === previous.excluded &&
          candidate.nominalLocal < previous.nominalLocal)
          ? candidate
          : previous;
      pending.set(candidate.at, {
        ...chosen,
        excluded: previous.excluded && candidate.excluded,
        generated: previous.generated || candidate.generated,
        explicit: previous.explicit || candidate.explicit,
      });
    }
  }
  for (const at of definition.rdates) {
    const local = ZonedDateTime.ofInstant(Instant.ofEpochMilli(at), zone);
    const offsets = zone
      .rules()
      .validOffsets(local.toLocalDateTime())
      .sort((a, b) => b.totalSeconds() - a.totalSeconds());
    const fold = offsets.findIndex((offset) => offset.equals(local.offset()));
    add({
      at,
      local: local.toLocalDateTime().toString(),
      nominalLocal: local.toLocalDateTime().toString(),
      offset: local.offset().toString(),
      fold,
      shifted: false,
      excluded:
        excludedInstants.has(at) ||
        excludedDates.has(local.toLocalDate().toString()),
      generated: false,
      explicit: true,
    });
  }
  function drain(safe: number): boolean {
    for (const candidate of [...pending.values()]
      .filter((value) => value.at <= safe)
      .sort((a, b) => a.at - b.at)) {
      pending.delete(candidate.at);
      const generated =
        candidate.generated &&
        (countLimit === null || cursor.generatedCount < countLimit);
      if (!generated && !candidate.explicit) continue;
      if (generated) cursor.generatedCount++;
      cursor.ordinal++;
      cursor.after = candidate.at;
      accounted++;
      const {
        generated: _generated,
        explicit: _explicit,
        ...entry
      } = candidate;
      if (candidate.at > options.after)
        occurrences.push({ ...entry, ordinal: cursor.ordinal });
      if (occurrences.length >= limit || accounted >= 1000) return true;
    }
    return false;
  }
  while (!day.isAfter(lastDate)) {
    if (++dates > maximumDates)
      throw new RecurrenceError(
        "search_limit",
        "The recurrence search exceeded its date budget. Narrow the range or simplify the rule.",
      );
    if (
      definition.count !== null &&
      cursor.generatedCount >= definition.count
    ) {
      drain(horizon);
      result.windowComplete = ![...pending.values()].some(
        (value) => value.explicit,
      );
      result.exhausted = !definition.rdates.some(
        (at) =>
          at > cursor.after &&
          at >= definition.start &&
          at <= (definition.end ?? maximumInstant),
      );
      if (result.windowComplete && !result.exhausted)
        cursor.after = Math.max(cursor.after, horizon);
      return result;
    }
    if (
      definition.rules.every(
        (rule) => !ruleMonthMatches(rule, day, anchor.toLocalDate()),
      )
    ) {
      const next = day.withDayOfMonth(1).plusMonths(1);
      if (
        drain(
          civilTime(next.minusDays(backward), 0).toEpochSecond(ZoneOffset.MAX) *
            1000 -
            1,
        )
      )
        return result;
      day = next;
      continue;
    }
    const matchingRules = definition.rules.filter((rule) =>
      ruleDateMatches(rule, day, anchor.toLocalDate()),
    );
    const shiftedDate = matchingRules.length
      ? businessDate(day, definition, holidays)
      : null;
    if (shiftedDate)
      for (const rule of matchingRules) {
        for (const minute of rule.times) {
          if (++result.evaluatedCandidates > maximumCandidates)
            throw new RecurrenceError(
              "search_limit",
              "The recurrence search exceeded its occurrence budget. Narrow the range or simplify the rule.",
            );
          const nominal = civilTime(day, minute);
          if (nominal.isBefore(anchor)) continue;
          for (const resolved of resolveLocal(
            civilTime(shiftedDate, minute),
            zone,
            definition.fold,
            definition.gap,
          )) {
            const local = ZonedDateTime.ofInstant(
              Instant.ofEpochMilli(resolved.at),
              zone,
            );
            add({
              ...resolved,
              local: local.toLocalDateTime().toString(),
              nominalLocal: nominal.toString(),
              offset: local.offset().toString(),
              shifted: resolved.shifted || !shiftedDate.equals(day),
              excluded:
                excludedInstants.has(resolved.at) ||
                excludedDates.has(day.toString()),
              generated: true,
              explicit: false,
            });
          }
        }
      }
    const next = definition.rules
      .map((rule) => nextPossibleDate(rule, day, anchor.toLocalDate()))
      .reduce((first, value) => (value.isBefore(first) ? value : first));
    const safeDate = next.minusDays(backward);
    if (drain(civilTime(safeDate, 0).toEpochSecond(ZoneOffset.MAX) * 1000 - 1))
      return result;
    day = next;
  }
  const stopped = drain(horizon);
  result.exhausted =
    !stopped &&
    ((definition.end !== null && horizon >= definition.end) ||
      (definition.generatedUntil !== null &&
        horizon >= definition.generatedUntil &&
        !definition.rdates.some(
          (at) =>
            at > cursor.after &&
            at >= definition.start &&
            at <= (definition.end ?? maximumInstant),
        )));
  result.windowComplete = !stopped;
  if (!stopped) cursor.after = Math.max(cursor.after, horizon);
  if (
    !result.exhausted &&
    definition.end === null &&
    horizon === maximumInstant &&
    !stopped
  )
    throw new RecurrenceError(
      "search_limit",
      "No occurrence was found within the bundled timezone-data horizon.",
    );
  return result;
}
