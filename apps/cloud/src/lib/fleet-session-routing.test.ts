import { describe, expect, it } from "vitest";
import { createId } from "../server/crypto";
import {
  summarizeProductSnapshot,
  type FleetDeviceStatus,
} from "./fleet-status";
import {
  fleetSessionRequestSchema,
  selectFleetSessionTarget,
} from "./fleet-session-routing";
import { productFixture } from "../test/product-fixture";

function device(): FleetDeviceStatus {
  return {
    instanceId: createId("instance"),
    displayName: "Device",
    online: true,
    productVersion: "29.0.0",
    versionStatus: "current",
    error: null,
    ...summarizeProductSnapshot(productFixture()),
  };
}

const target = (device: FleetDeviceStatus) => ({
  instanceId: device.instanceId,
  workspace: "/projects/example",
});

describe("fleet session placement", () => {
  it("requires an advertised routing capability instead of inferring it from a version", () => {
    const snapshot = productFixture();
    delete snapshot.shell!.sessionRoutingAvailable;
    expect(summarizeProductSnapshot(snapshot).canCreateSession).toBe(false);
    snapshot.shell!.sessionRoutingAvailable = true;
    expect(summarizeProductSnapshot(snapshot).canCreateSession).toBe(true);
    snapshot.enabled = false;
    expect(summarizeProductSnapshot(snapshot).canCreateSession).toBe(false);
  });

  it("chooses the least busy device only among the selected workspaces", () => {
    const busy = device();
    busy.tasks = [
      {
        taskId: "running",
        state: "running",
        message: "",
        cancellable: true,
        updatedAt: 1,
      },
    ];
    const idle = device();
    const unselected = device();
    expect(
      selectFleetSessionTarget(
        [busy, idle, unselected],
        [target(busy), target(idle)],
      ),
    ).toEqual(target(idle));
    expect(
      selectFleetSessionTarget([busy, idle, unselected], [target(busy)]),
    ).toEqual(target(busy));
  });

  it("uses CPU and memory pressure to break task-count ties", () => {
    const left = device();
    const right = device();
    const telemetry = {
      capturedAt: 1,
      platform: "linux",
      architecture: "x64",
      cpuCount: 4,
      cpuUsagePercent: 50,
      memoryTotalBytes: 1000,
      memoryUsedBytes: 500,
      uptimeSeconds: 1,
    };
    left.telemetry = {
      ...telemetry,
      cpuUsagePercent: 60,
      memoryUsedBytes: 100,
    };
    right.telemetry = {
      ...telemetry,
      cpuUsagePercent: 10,
      memoryUsedBytes: 900,
    };
    expect(
      selectFleetSessionTarget([left, right], [target(left), target(right)]),
    ).toEqual(target(right));
    left.telemetry.cpuUsagePercent = 10;
    expect(
      selectFleetSessionTarget([left, right], [target(left), target(right)]),
    ).toEqual(target(left));
    left.telemetry.memoryTotalBytes = 0;
    left.telemetry.memoryUsedBytes = 0;
    expect(
      selectFleetSessionTarget([left, right], [target(left), target(right)]),
    ).toEqual(target(right));
  });

  it.each([
    { online: false },
    { error: "Unavailable" },
    { canCreateSession: false },
    { versionStatus: "incompatible" as const },
    { workspaces: [] },
  ])("excludes a device with unusable status %j", (status) => {
    const candidate = device();
    Object.assign(candidate, status);
    expect(
      selectFleetSessionTarget([candidate], [target(candidate)]),
    ).toBeNull();
  });

  it("rejects an empty, excessive, duplicated, or malformed scope", () => {
    const candidate = target(device());
    const commandId = crypto.randomUUID();
    for (const targets of [
      [],
      Array.from({ length: 17 }, () => candidate),
      [candidate, candidate],
      [{ ...candidate, instanceId: "../device" }],
      [{ ...candidate, workspace: "" }],
    ])
      expect(
        fleetSessionRequestSchema.safeParse({ commandId, targets }).success,
      ).toBe(false);
    expect(
      fleetSessionRequestSchema.safeParse({ commandId, targets: [candidate] })
        .success,
    ).toBe(true);
  });
});
