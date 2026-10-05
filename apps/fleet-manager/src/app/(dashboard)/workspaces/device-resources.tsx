import type { HostTelemetry } from "@machdoch/fleet-protocol";

export function DeviceResources({
  telemetry,
}: {
  telemetry: HostTelemetry;
}): React.ReactElement {
  const memoryPercent =
    telemetry.memoryTotalBytes > 0
      ? (telemetry.memoryUsedBytes / telemetry.memoryTotalBytes) * 100
      : null;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      <div className="flex gap-2">
        <dt className="text-muted-foreground">CPU</dt>
        <dd>
          {telemetry.cpuUsagePercent === null
            ? "—"
            : `${telemetry.cpuUsagePercent.toFixed(0)}%`}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground">Memory</dt>
        <dd>
          {memoryPercent === null
            ? "—"
            : `${(telemetry.memoryUsedBytes / 1024 ** 3).toFixed(1)} / ${(telemetry.memoryTotalBytes / 1024 ** 3).toFixed(1)} GB`}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground">System</dt>
        <dd>
          {telemetry.platform} · {telemetry.architecture}
        </dd>
      </div>
    </dl>
  );
}
