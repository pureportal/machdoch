# Recurrence

The client scheduler, cloud recurrence preview and schedule coordinator use this evaluator. It calculates occurrences; it does not admit tasks, own timers, claim writers or perform external effects. The cloud coordinator creates issues or admits bounded AI tasks using PostgreSQL occurrence receipts and the shared task admission service. Fixed-delay continuations use recorded terminal timestamps. The broader workflow model in [the automation specification](../../docs/machdoch-cloud/automation.md) remains further implementation work.

## Inputs

`normalizeRecurrence` accepts the types exported from `src/contract.ts` and produces one versioned definition and content key. Instants use ISO timestamps with an offset, between 1970 and 2499. Calendar rules have minute precision. Start and end are inclusive; evaluation's `after` is exclusive and `through` is inclusive.

| Kind | Supported input |
| --- | --- |
| `once` | One instant |
| `interval` | Start anchor, positive elapsed milliseconds, optional end |
| `fixed-delay` | Start, positive delay milliseconds, optional end; subsequent occurrences require the previous domain completion timestamp |
| `calendar` | Union of daily, weekly, monthly or yearly rules; intervals, times, months, month days and ordinal weekdays |
| `cron` | Five fields; lists, ascending ranges, steps, English month/weekday names; `L`, `LW`, `nW`, weekday `L` and weekday `#1` through `#5` |
| `rrule` | `FREQ=DAILY/WEEKLY/MONTHLY/YEARLY`, `INTERVAL`, `COUNT` or UTC `UNTIL`, `BYMONTH`, `BYMONTHDAY`, `BYDAY`, `BYHOUR`, `BYMINUTE`, `WKST`; optional `RRULE:` prefix |

Cron day-of-month and weekday restrictions combine with OR when both are constrained. Sunday is 0 or 7. Seconds and macros are unsupported. RRULE ordinal weekdays require monthly recurrence, or yearly recurrence with explicit months. Weekly `BYMONTHDAY`, sub-minute recurrence, `BYSETPOS`, other unlisted clauses, duplicate properties and floating `UNTIL` values are rejected. This is a supported subset of [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.5.3), not an iCalendar parser.

Calendar inputs include explicit excluded dates/instants and an optional versioned business calendar. RRULE input additionally accepts explicit `rdates`. `COUNT` counts generated instants before exclusions; `UNTIL` limits generated instants. Explicit dates can outlive either, but remain inside the definition's start/end bounds. Collisions produce one occurrence. Business calendars supply their own working weekdays and holidays, with skip/next/previous behavior and a bounded shift distance; no locale-derived holidays are assumed.

Timezone arithmetic uses pinned `@js-joda/core` 6.3.0 and `@js-joda/timezone` 3.1.0 (bundled tzdb 2026e), independent of host `Intl` data. Definitions retain the tzdb version. Ambiguous local times default to the earlier instant; `fold: "both"` yields both in UTC order. Missing local times default to skip; `gap: "shift-forward"` moves by the transition duration. Dates outside bundled coverage fail explicitly.

## Evaluation and preview

`evaluateRecurrence` returns ordered occurrences, including excluded occurrences for ledger accounting, plus a definition-bound cursor. Persist the cursor only with the corresponding accepted occurrence records. `exhausted` means no remaining occurrence; `windowComplete` means the requested window is accounted for. A fixed-delay result can require a completion timestamp instead. Search-budget errors do not mean a schedule is exhausted. Bounded evaluation can advance a cursor without returning an eligible occurrence.

`previewRecurrence` returns up to 20 non-excluded occurrences without persisting state. Its optional fourth argument, `fromActivation`, previews the first fixed-delay date relative to the supplied instant when the original start is in the past. Later dates still require actual completion timestamps. The cloud exposes preview through authenticated `POST /api/v1/recurrence/preview` and the read-only `preview_recurrence` MCP tool. Request fields are `recurrence`, optional `after`, `count` (default 5), and optional `fromActivation`. Preview runs in a worker with a time and heap limit, four concurrent evaluations per server and two per organization. Access is checked before evaluation and again before returning results. Preview does not create an automation or run.

## Checks

Run `pnpm --filter @machdoch/recurrence test` and `pnpm --filter @machdoch/recurrence typecheck`. The corpus includes RFC weekly/month-day examples, leap centuries, half-hour and whole-day transitions, exclusions, explicit-date unions, count/UNTIL boundaries, business-calendar shifts and cursor continuation. Client storage tests cover recomputing cron caches once when evaluator/timezone semantics change while preserving definitions and admitted runs.
