"use client";

import { useEffect, useState } from "react";
import { formatAge } from "@/lib/format";

export function RelativeTime({
  value,
  compact = false,
  prefix = "",
}: {
  value: string;
  compact?: boolean;
  prefix?: string;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const age = now === null ? "" : formatAge(value, now);
  return (
    <time dateTime={value} title={new Date(value).toUTCString()}>
      {age && `${prefix}${compact ? age.replace(" ago", "") : age}`}
    </time>
  );
}
