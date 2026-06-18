const MINUTE_MS = 60_000;
const CRON_LOOKAHEAD_MS = 366 * 24 * 60 * MINUTE_MS;

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface CronField {
  any: boolean;
  values: ReadonlySet<number>;
  lastDayOfMonth: boolean;
  lastWeekdays: ReadonlySet<number>;
}

export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export interface TimeZoneDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

const getDaysInMonth = (year: number, month: number): number => {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const createRange = (min: number, max: number): number[] => {
  return Array.from({ length: max - min + 1 }, (_value, index) => min + index);
};

const parseCronNumber = (
  value: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>>,
  normalize?: (value: number) => number,
): number => {
  const raw = value.trim().toLowerCase();
  const named = names[raw];
  const parsed = named ?? Number(raw);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron field value: ${value}`);
  }

  const normalized = normalize?.(parsed) ?? parsed;

  if (normalized < min || normalized > max) {
    throw new Error(`Cron field value out of range: ${value}`);
  }

  return normalized;
};

const parseCronField = (
  field: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>> = {},
  options?: {
    allowLastDayOfMonth?: boolean;
    allowLastWeekday?: boolean;
    normalize?: (value: number) => number;
  },
): CronField => {
  const values = new Set<number>();
  const lastWeekdays = new Set<number>();
  let any = false;
  let lastDayOfMonth = false;

  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();

    if (!part) {
      throw new Error(`Invalid cron field: ${field}`);
    }

    if (part === "*") {
      any = true;
      for (const value of createRange(min, max)) {
        values.add(value);
      }
      continue;
    }

    if (part === "L" && options?.allowLastDayOfMonth) {
      lastDayOfMonth = true;
      continue;
    }

    if (part.endsWith("L") && options?.allowLastWeekday) {
      const weekday = parseCronNumber(
        part.slice(0, -1),
        min,
        max,
        names,
        options.normalize,
      );
      lastWeekdays.add(weekday);
      continue;
    }

    const [base, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;

    if (!base || !Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${part}`);
    }

    const range =
      base === "*"
        ? [min, max]
        : base.includes("-")
          ? base
              .split("-")
              .map((value) =>
                parseCronNumber(value, min, max, names, options?.normalize),
              )
          : [
              parseCronNumber(base, min, max, names, options?.normalize),
              parseCronNumber(base, min, max, names, options?.normalize),
            ];
    const [start, end] = range;

    if (start === undefined || end === undefined || start > end) {
      throw new Error(`Invalid cron range: ${part}`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return {
    any,
    values,
    lastDayOfMonth,
    lastWeekdays,
  };
};

export const parseCronExpression = (expression: string): ParsedCronExpression => {
  const fields = expression.trim().split(/\s+/u);

  if (fields.length !== 5) {
    throw new Error("Cron schedules must use five fields; seconds are not supported.");
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, {}, {
      allowLastDayOfMonth: true,
    }),
    month: parseCronField(month, 1, 12, MONTH_NAMES),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6, WEEKDAY_NAMES, {
      allowLastWeekday: true,
      normalize: (value) => (value === 7 ? 0 : value),
    }),
  };
};

const getTimeZoneDateParts = (
  timestamp: number,
  timezone: string,
): TimeZoneDateParts => {
  const formatter = new Intl.DateTimeFormat("en-US-u-hc-h23", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = new Map(
    formatter.formatToParts(new Date(timestamp)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  const weekday = parts.get("weekday")?.toLowerCase().slice(0, 3);
  const dayOfWeek = weekday ? WEEKDAY_NAMES[weekday] : undefined;

  if (dayOfWeek === undefined) {
    throw new Error(`Unable to resolve weekday in timezone ${timezone}.`);
  }

  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    dayOfWeek,
  };
};

const cronFieldMatches = (
  field: CronField,
  value: number,
  parts: TimeZoneDateParts,
  kind: "dayOfMonth" | "dayOfWeek" | "other",
): boolean => {
  if (field.values.has(value)) {
    return true;
  }

  if (
    kind === "dayOfMonth" &&
    field.lastDayOfMonth &&
    parts.day === getDaysInMonth(parts.year, parts.month)
  ) {
    return true;
  }

  if (
    kind === "dayOfWeek" &&
    field.lastWeekdays.has(value) &&
    parts.day + 7 > getDaysInMonth(parts.year, parts.month)
  ) {
    return true;
  }

  return false;
};

const cronDayMatches = (
  parsed: ParsedCronExpression,
  parts: TimeZoneDateParts,
): boolean => {
  const dayOfMonthMatches = cronFieldMatches(
    parsed.dayOfMonth,
    parts.day,
    parts,
    "dayOfMonth",
  );
  const dayOfWeekMatches = cronFieldMatches(
    parsed.dayOfWeek,
    parts.dayOfWeek,
    parts,
    "dayOfWeek",
  );

  if (!parsed.dayOfMonth.any && !parsed.dayOfWeek.any) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }

  return dayOfMonthMatches && dayOfWeekMatches;
};

const cronExpressionMatches = (
  parsed: ParsedCronExpression,
  parts: TimeZoneDateParts,
): boolean => {
  return (
    cronFieldMatches(parsed.minute, parts.minute, parts, "other") &&
    cronFieldMatches(parsed.hour, parts.hour, parts, "other") &&
    cronFieldMatches(parsed.month, parts.month, parts, "other") &&
    cronDayMatches(parsed, parts)
  );
};

export const getNextCronRunAfter = (
  expression: string,
  timezone: string,
  afterTimestamp: number,
): number => {
  const parsed = parseCronExpression(expression);
  const endTimestamp = afterTimestamp + CRON_LOOKAHEAD_MS;
  let candidate =
    Math.floor(afterTimestamp / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  while (candidate <= endTimestamp) {
    if (
      cronExpressionMatches(
        parsed,
        getTimeZoneDateParts(candidate, timezone),
      )
    ) {
      return candidate;
    }

    candidate += MINUTE_MS;
  }

  throw new Error(`Unable to find next cron run within one year: ${expression}`);
};
