import type { HostTelemetry } from "@machdoch/fleet-protocol";
import { cn } from "@/lib/utils";

const gigabyte = 1024 ** 3;

function Meter({
  label,
  percent,
  value,
}: {
  label: string;
  percent: number | null;
  value: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      {percent !== null ? (
        <span
          className="h-1.5 w-14 overflow-hidden rounded-full bg-muted"
          aria-hidden="true"
        >
          <span
            className={cn(
              "block h-full rounded-full",
              percent >= 90
                ? "bg-destructive"
                : percent >= 75
                  ? "bg-amber-500"
                  : "bg-emerald-500",
            )}
            style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
          />
        </span>
      ) : null}
      <dd className="whitespace-nowrap tabular-nums">{value}</dd>
    </div>
  );
}

export function DeviceResources({
  telemetry,
}: {
  telemetry: HostTelemetry;
}): React.ReactElement {
  const cpu = telemetry.cpuUsagePercent;
  const memoryPercent =
    telemetry.memoryTotalBytes > 0
      ? (telemetry.memoryUsedBytes / telemetry.memoryTotalBytes) * 100
      : null;
  return (
    <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
      <Meter
        label="CPU"
        percent={cpu}
        value={cpu === null ? "—" : `${cpu.toFixed(0)}%`}
      />
      <Meter
        label="Memory"
        percent={memoryPercent}
        value={
          memoryPercent === null
            ? "—"
            : `${(telemetry.memoryUsedBytes / gigabyte).toFixed(1)} / ${(telemetry.memoryTotalBytes / gigabyte).toFixed(1)} GB`
        }
      />
      <div className="flex items-center gap-2">
        <dt className="sr-only">System</dt>
        <dd className="text-muted-foreground">
          <span className="capitalize">{telemetry.platform}</span> ·{" "}
          {telemetry.architecture}
        </dd>
      </div>
    </dl>
  );
}
