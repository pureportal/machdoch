const timestamp = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export function Timestamp({ value }: { value: string | number }) {
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {timestamp.format(date)} UTC
    </time>
  );
}
