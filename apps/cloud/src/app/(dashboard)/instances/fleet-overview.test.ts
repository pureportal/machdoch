import { describe, expect, it } from "vitest";
import {
  selectDevices,
  summarizeFleet,
  type FleetInstance,
} from "./fleet-overview";

const devices: FleetInstance[] = [
  {
    instanceId: "device-online",
    displayName: "Studio 10",
    productVersion: "24.0.0",
    protocolVersion: 1,
    status: "online",
    enrolledAt: 10,
    lastSeenAt: 100,
  },
  {
    instanceId: "device-offline",
    displayName: "Studio 2",
    productVersion: "23.0.0",
    protocolVersion: 1,
    status: "offline",
    enrolledAt: 20,
    lastSeenAt: 50,
  },
  {
    instanceId: "device-new",
    displayName: "New host",
    productVersion: "24.0.0",
    protocolVersion: 1,
    status: "offline",
    enrolledAt: 30,
    lastSeenAt: null,
  },
  {
    instanceId: "device-revoked",
    displayName: "Retired",
    productVersion: "22.0.0",
    protocolVersion: 1,
    status: "revoked",
    enrolledAt: 40,
    lastSeenAt: 150,
  },
];

describe("fleet overview", () => {
  it("counts active connections without treating revoked devices as offline", () => {
    expect(summarizeFleet(devices)).toEqual({
      active: 3,
      online: 1,
      offline: 2,
      revoked: 1,
    });
    expect(summarizeFleet([])).toEqual({
      active: 0,
      online: 0,
      offline: 0,
      revoked: 0,
    });
  });

  it("prioritizes never-connected devices and the oldest offline contact", () => {
    const before = [...devices];
    expect(
      selectDevices(devices, "", "active", "status").map(
        (device) => device.instanceId,
      ),
    ).toEqual(["device-new", "device-offline", "device-online"]);
    expect(devices).toEqual(before);
  });

  it("combines status filtering with case-insensitive name, ID, and version searches", () => {
    expect(selectDevices(devices, "  STUDIO  ", "offline", "name")).toEqual([
      devices[1],
    ]);
    expect(selectDevices(devices, "DEVICE-ONLINE", "active", "name")).toEqual([
      devices[0],
    ]);
    expect(selectDevices(devices, "23.0.0", "active", "name")).toEqual([
      devices[1],
    ]);
    expect(selectDevices(devices, "Retired", "active", "name")).toEqual([]);
    expect(selectDevices(devices, "", "revoked", "name")).toEqual([devices[3]]);
  });

  it("sorts names naturally and keeps never-connected devices last when sorting by last seen", () => {
    expect(
      selectDevices(devices, "Studio", "active", "name").map(
        (device) => device.displayName,
      ),
    ).toEqual(["Studio 2", "Studio 10"]);
    expect(
      selectDevices(devices, "", "active", "last-seen").map(
        (device) => device.instanceId,
      ),
    ).toEqual(["device-online", "device-offline", "device-new"]);
  });

  it("sorts newly enrolled devices first and resolves equal names deterministically", () => {
    expect(
      selectDevices(devices, "", "active", "enrolled").map(
        (device) => device.instanceId,
      ),
    ).toEqual(["device-new", "device-offline", "device-online"]);
    const duplicates = [
      { ...devices[0]!, instanceId: "z" },
      { ...devices[0]!, instanceId: "a" },
    ];
    expect(
      selectDevices(duplicates, "", "online", "name").map(
        (device) => device.instanceId,
      ),
    ).toEqual(["a", "z"]);
  });
});
