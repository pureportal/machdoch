"use client";

import { useEffect, useRef, useState } from "react";
import type { RecurrenceInput, previewRecurrence } from "@machdoch/recurrence";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cloudRequest } from "./api-client";

type Preview = ReturnType<typeof previewRecurrence>;
type Frequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "cron"
  | "interval"
  | "fixed-delay"
  | "once"
  | "advanced";

function editorValues(input?: RecurrenceInput) {
  const values = {
    frequency: "weekly" as Frequency,
    start: new Date().toISOString().slice(0, 16),
    timezone: "UTC",
    time: "09:00",
    weekday: "1",
    monthDay: "1",
    interval: "60",
    cron: "0 9 * * MON-FRI",
  };
  if (!input) return values;
  values.frequency = "advanced";
  values.start = new Date(input.kind === "once" ? input.at : input.start)
    .toISOString()
    .slice(0, 16);
  if (input.kind === "once") values.frequency = "once";
  if (input.kind === "interval" && !input.end && input.everyMs % 60000 === 0) {
    values.frequency = "interval";
    values.interval = String(input.everyMs / 60000);
  }
  if (
    input.kind === "fixed-delay" &&
    !input.end &&
    input.delayMs % 60000 === 0
  ) {
    values.frequency = "fixed-delay";
    values.interval = String(input.delayMs / 60000);
  }
  if (
    input.kind === "calendar" ||
    input.kind === "cron" ||
    input.kind === "rrule"
  ) {
    values.timezone = input.timezone;
    const simple =
      !input.end &&
      !input.business &&
      !input.excludeDates?.length &&
      !input.excludeInstants?.length &&
      input.fold !== "both" &&
      input.gap !== "shift-forward";
    if (simple && input.kind === "cron") {
      values.frequency = "cron";
      values.cron = input.expression;
    }
    if (
      simple &&
      input.kind === "calendar" &&
      !input.count &&
      input.rules.length === 1
    ) {
      const rule = input.rules[0]!;
      if (
        (rule.interval ?? 1) === 1 &&
        rule.times.length === 1 &&
        !rule.months &&
        ["daily", "weekly", "monthly"].includes(rule.frequency) &&
        (rule.weekdays?.length ?? 0) <= 1 &&
        !rule.weekdays?.[0]?.ordinal &&
        (rule.monthDays?.length ?? 0) <= 1 &&
        (rule.frequency !== "weekly" || rule.weekdays?.length === 1) &&
        (rule.frequency !== "monthly" ||
          (rule.monthDays?.length === 1 && rule.monthDays[0]! >= -1)) &&
        !(rule.weekdays && rule.frequency !== "weekly") &&
        !(rule.monthDays && rule.frequency !== "monthly")
      ) {
        values.frequency = rule.frequency as Frequency;
        values.time = rule.times[0]!;
        values.weekday = String(rule.weekdays?.[0]?.day ?? 1);
        values.monthDay = String(rule.monthDays?.[0] ?? 1);
      }
    }
  }
  if (Date.parse(input.kind === "once" ? input.at : input.start) % 60_000 !== 0)
    values.frequency = "advanced";
  return values;
}

export function ScheduleRecurrence({
  initial,
  onChange,
  completionLabel,
  waitingForTask,
}: {
  initial?: RecurrenceInput;
  onChange: (value: RecurrenceInput | null) => void;
  completionLabel: string;
  waitingForTask: boolean;
}) {
  const [defaults] = useState(() => editorValues(initial));
  const [frequency, setFrequency] = useState<Frequency>(defaults.frequency);
  const [timezone, setTimezone] = useState(defaults.timezone);
  const [start, setStart] = useState(defaults.start);
  const [time, setTime] = useState(defaults.time);
  const [weekday, setWeekday] = useState(defaults.weekday);
  const [monthDay, setMonthDay] = useState(defaults.monthDay);
  const [interval, setInterval] = useState(defaults.interval);
  const [cron, setCron] = useState(defaults.cron);
  const [advanced, setAdvanced] = useState(() =>
    JSON.stringify(
      initial ?? {
        kind: "cron",
        expression: "0 9 * * MON-FRI",
        timezone: "UTC",
        start: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const [preview, setPreview] = useState<{
    key: string;
    result: Preview;
  } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const feedback = useRef<HTMLDivElement | null>(null);
  let input: RecurrenceInput | null = null;
  try {
    const instant = `${start}:00Z`;
    if (frequency === "advanced")
      input = JSON.parse(advanced) as RecurrenceInput;
    else if (frequency === "once") input = { kind: "once", at: instant };
    else if (frequency === "fixed-delay")
      input = {
        kind: "fixed-delay",
        start: instant,
        delayMs: Number(interval) * 60000,
      };
    else if (frequency === "interval")
      input = {
        kind: "interval",
        start: instant,
        everyMs: Number(interval) * 60_000,
      };
    else if (frequency === "cron")
      input = { kind: "cron", start: instant, timezone, expression: cron };
    else
      input = {
        kind: "calendar",
        start: instant,
        timezone,
        rules: [
          {
            frequency,
            times: [time],
            ...(frequency === "weekly"
              ? { weekdays: [{ day: Number(weekday) }] }
              : frequency === "monthly"
                ? { monthDays: [Number(monthDay)] }
                : {}),
          },
        ],
      };
  } catch {
    input = null;
  }
  const serialized = JSON.stringify(input);
  const waitsForTask = waitingForTask && input?.kind === "fixed-delay";
  const latest = useRef(serialized);
  latest.current = serialized;
  useEffect(() => {
    onChange(JSON.parse(serialized) as RecurrenceInput | null);
    abort.current?.abort();
    setPending(false);
    setError("");
  }, [serialized, onChange]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!error && preview?.key !== serialized) return;
    feedback.current?.focus({ preventScroll: true });
    feedback.current?.scrollIntoView({ block: "center" });
  }, [error, preview, serialized]);
  return (
    <div className="grid min-w-0 gap-4">
      <Field label="Repeat" htmlFor="schedule-repeat">
        <Select
          id="schedule-repeat"
          value={frequency}
          onChange={(event) => {
            if (event.target.value === "advanced" && input)
              setAdvanced(JSON.stringify(input, null, 2));
            setFrequency(event.target.value as Frequency);
          }}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="interval">Every interval</option>
          <option value="fixed-delay">{completionLabel}</option>
          <option value="once">Once</option>
          <option value="cron">Cron</option>
          <option value="advanced">Advanced rule</option>
        </Select>
      </Field>
      {frequency === "advanced" ? (
        <Field label="Recurrence JSON" htmlFor="schedule-json">
          <Textarea
            id="schedule-json"
            value={advanced}
            onChange={(event) => setAdvanced(event.target.value)}
            rows={8}
            maxLength={100_000}
            required
          />
        </Field>
      ) : (
        <>
          <Field label="Starts (UTC)" htmlFor="schedule-start">
            <Input
              id="schedule-start"
              type="datetime-local"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              required
            />
          </Field>
          {!["interval", "fixed-delay", "once"].includes(frequency) && (
            <Field label="Timezone" htmlFor="schedule-timezone">
              <Input
                id="schedule-timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                maxLength={100}
                required
              />
            </Field>
          )}
          {["daily", "weekly", "monthly"].includes(frequency) && (
            <Field label="Time" htmlFor="schedule-time">
              <Input
                id="schedule-time"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                required
              />
            </Field>
          )}
          {frequency === "weekly" && (
            <Field label="Weekday" htmlFor="schedule-weekday">
              <Select
                id="schedule-weekday"
                value={weekday}
                onChange={(event) => setWeekday(event.target.value)}
              >
                {[
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                  "Sunday",
                ].map((day, index) => (
                  <option key={day} value={index + 1}>
                    {day}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {frequency === "monthly" && (
            <Field label="Day of month" htmlFor="schedule-monthday">
              <Select
                id="schedule-monthday"
                value={monthDay}
                onChange={(event) => setMonthDay(event.target.value)}
              >
                {Array.from({ length: 31 }, (_, index) => (
                  <option key={index} value={index + 1}>
                    {index + 1}
                  </option>
                ))}
                <option value="-1">Last day</option>
              </Select>
            </Field>
          )}
          {["interval", "fixed-delay"].includes(frequency) && (
            <Field
              label={
                frequency === "fixed-delay"
                  ? "Delay (minutes)"
                  : "Interval (minutes)"
              }
              htmlFor="schedule-interval"
            >
              <Input
                id="schedule-interval"
                type="number"
                min={1}
                max={52560000}
                value={interval}
                onChange={(event) => setInterval(event.target.value)}
                required
              />
            </Field>
          )}
          {frequency === "cron" && (
            <Field
              label="Cron expression"
              htmlFor="schedule-cron"
              hint="Five fields: minute, hour, day, month, weekday."
            >
              <Input
                id="schedule-cron"
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                maxLength={256}
                required
              />
            </Field>
          )}
        </>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !input}
          onClick={() => {
            abort.current?.abort();
            const controller = new AbortController();
            abort.current = controller;
            const key = serialized;
            setPending(true);
            setError("");
            setPreview(null);
            void cloudRequest<Preview>("recurrence/preview", {
              method: "POST",
              body: { recurrence: input, count: 5, fromActivation: true },
              signal: controller.signal,
            })
              .then((result) => {
                if (!controller.signal.aborted && key === latest.current)
                  setPreview({ key, result });
              })
              .catch((reason: Error) => {
                if (!controller.signal.aborted && key === latest.current)
                  setError(reason.message);
              })
              .finally(() => {
                if (!controller.signal.aborted && key === latest.current)
                  setPending(false);
              });
          }}
        >
          {pending ? "Calculating…" : "Preview dates"}
        </Button>
      </div>
      {frequency === "advanced" && !input && (
        <p role="alert">Enter valid recurrence JSON.</p>
      )}
      {(error || preview?.key === serialized) && (
        <div ref={feedback} tabIndex={-1} className="grid gap-2 outline-none">
          {error && <p role="alert">{error}</p>}
          {preview?.key === serialized && (
            <section aria-label="Upcoming dates" className="grid gap-2 text-sm">
              {waitsForTask ? (
                <p>
                  The first date will be set after the current task finishes.
                </p>
              ) : preview.result.occurrences.length ? (
                <ol className="grid gap-2">
                  {preview.result.occurrences.map((value) => (
                    <li
                      key={value.at}
                      className="flex flex-wrap justify-between gap-x-4"
                    >
                      <span>
                        {value.local.replace("T", " ")} {value.offset}
                      </span>
                      <time dateTime={new Date(value.at).toISOString()}>
                        {new Date(value.at)
                          .toISOString()
                          .replace("T", " ")
                          .replace(".000Z", " UTC")}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No upcoming dates.</p>
              )}
              {!waitsForTask && preview.result.waitingForCompletion && (
                <p>Later dates depend on when the preceding work finishes.</p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
