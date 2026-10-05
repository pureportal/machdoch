import { describe, expect, it } from "vitest";
import { hostTelemetrySchema } from "@machdoch/fleet-protocol";
import { collectFleetTelemetry, cpuUsagePercent } from "./fleet-telemetry.js";

describe("fleet host telemetry", () => {
  it("reports no CPU estimate until two samples exist", () => {
    expect(cpuUsagePercent(null, { idle: 50, total: 100 })).toBeNull();
    expect(
      cpuUsagePercent({ idle: 50, total: 100 }, { idle: 75, total: 200 }),
    ).toBe(75);
  });

  it("rejects reset and inconsistent CPU counters", () => {
    const previous = { idle: 50, total: 100 };
    expect(cpuUsagePercent(previous, previous)).toBeNull();
    expect(cpuUsagePercent(previous, { idle: 0, total: 0 })).toBeNull();
    expect(cpuUsagePercent(previous, { idle: 70, total: 110 })).toBeNull();
  });

  it("collects real hardware measurements within the gateway schema", () => {
    expect(hostTelemetrySchema.safeParse(collectFleetTelemetry()).success).toBe(
      true,
    );
  });
});
