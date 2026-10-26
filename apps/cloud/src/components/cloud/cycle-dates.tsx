import type { CloudCycle } from "@/lib/cloud-contract";

export function CycleDates({ cycle }: { cycle: CloudCycle }) {
  const format = (value: string) =>
    new Date(`${value}T12:00:00Z`).toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  return (
    <span>
      <time dateTime={cycle.startsOn}>{format(cycle.startsOn)}</time> —{" "}
      <time dateTime={cycle.endsOn}>{format(cycle.endsOn)}</time>
    </span>
  );
}
