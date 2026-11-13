"use client";

import { useEffect, useState } from "react";

const options: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};
const universal = new Intl.DateTimeFormat("en", {
  ...options,
  timeZone: "UTC",
});

export function Timestamp({ value }: { value: string | number }) {
  const date = new Date(value);
  const [local, setLocal] = useState<Intl.DateTimeFormat | null>(null);
  useEffect(() => setLocal(new Intl.DateTimeFormat(undefined, options)), []);
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {local ? local.format(date) : `${universal.format(date)} UTC`}
    </time>
  );
}
