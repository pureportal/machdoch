import { arch, cpus, freemem, platform, totalmem, uptime } from "node:os";
import type { HostTelemetry } from "@machdoch/fleet-protocol";

interface CpuSample {
  idle: number;
  total: number;
}

export function cpuUsagePercent(
  previous: CpuSample | null,
  current: CpuSample,
): number | null {
  if (!previous) return null;
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (elapsed <= 0 || idle < 0 || idle > elapsed) return null;
  return Math.round((1 - idle / elapsed) * 10_000) / 100;
}

let previousCpuSample: CpuSample | null = null;

export function collectFleetTelemetry(): HostTelemetry {
  const processors = cpus();
  const sample = processors.reduce(
    (result, processor) => ({
      idle: result.idle + processor.times.idle,
      total:
        result.total +
        Object.values(processor.times).reduce((sum, time) => sum + time, 0),
    }),
    { idle: 0, total: 0 },
  );
  const cpuUsage = cpuUsagePercent(previousCpuSample, sample);
  previousCpuSample = sample;
  const memoryTotal = totalmem();
  return {
    capturedAt: Date.now(),
    platform: platform(),
    architecture: arch(),
    cpuCount: Math.max(1, processors.length),
    cpuUsagePercent: cpuUsage,
    memoryTotalBytes: memoryTotal,
    memoryUsedBytes: Math.max(
      0,
      Math.min(memoryTotal, memoryTotal - freemem()),
    ),
    uptimeSeconds: Math.floor(uptime()),
  };
}
