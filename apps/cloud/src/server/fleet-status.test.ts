import { type HostResponse } from "@machdoch/fleet-protocol";
import { describe, expect, it, vi } from "vitest";
import { summarizeProductSnapshot } from "../lib/fleet-status";
import type { FleetRuntime } from "./runtime";
import { collectFleetStatus } from "./fleet-status";
import { productFixture } from "../test/product-fixture";

describe("fleet status collection", () => {
  it("summarizes sessions and failures without forwarding messages, drafts, or logs", () => {
    const snapshot = productFixture();
    snapshot.sessions = [
      {
        taskId: "failed-task",
        task: "Private task prompt",
        state: "failed",
        mode: "machdoch",
        message: "Worker crashed.",
        cancellable: false,
        startedAt: 1,
        updatedAt: 2,
        progressCount: 0,
        logs: [{ createdAt: 1, stream: "stdout", chunk: "Private log" }],
        timeline: [],
      },
    ];
    const summary = summarizeProductSnapshot(snapshot);
    expect(summary.failures).toEqual([
      { id: "failed-task", message: "Worker crashed.", updatedAt: 2 },
    ]);
    expect(summary.sessions.length).toBeGreaterThan(0);
    expect(summary).not.toHaveProperty("commands");
    expect(summary).not.toHaveProperty("shell");
    expect(summary.tasks[0]).not.toHaveProperty("task");
    expect(summary.tasks[0]).not.toHaveProperty("logs");
  });

  it("limits fanout, includes offline devices, and isolates a failing device", async () => {
    const instances = Array.from({ length: 11 }, (_, index) => ({
      instanceId: `device-${index}`,
      displayName: `Device ${index}`,
      revokedAt: null,
      productVersion: "29.0.0",
      protocolVersion: 4,
    }));
    let active = 0;
    let maximum = 0;
    const relay = vi.fn(async (id: string): Promise<HostResponse> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (id === "device-3") throw new Error("Device unavailable.");
      return {
        type: "productSnapshot",
        snapshot: {
          enabled: true,
          serverTime: 123,
          eventId: 0,
          sessions: [],
          commands: [],
        },
      };
    });
    const runtime = {
      fleetStore: {
        listInstances: () => instances,
        getInstance: (id: string) =>
          instances.find((instance) => instance.instanceId === id),
      },
      gateways: { isOnline: (id: string) => id !== "device-10", relay },
    } as unknown as FleetRuntime;
    const result = await collectFleetStatus(
      runtime,
      new AbortController().signal,
    );
    expect(maximum).toBe(4);
    expect(relay).toHaveBeenCalledTimes(10);
    expect(result.devices).toHaveLength(11);
    expect(result.devices[3]!.error).toBe("Device unavailable.");
    expect(result.devices[10]).toMatchObject({
      online: false,
      capturedAt: null,
    });
    expect(result.devices[0]!.capturedAt).toBe(123);
  });

  it("does not dispatch work after request cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const relay = vi.fn();
    const instance = {
      instanceId: "device",
      displayName: "Device",
      revokedAt: null,
      productVersion: "29.0.0",
      protocolVersion: 4,
    };
    const runtime = {
      fleetStore: {
        listInstances: () => [instance],
        getInstance: () => instance,
      },
      gateways: { isOnline: () => true, relay },
    } as unknown as FleetRuntime;
    await expect(
      collectFleetStatus(runtime, controller.signal),
    ).rejects.toThrow();
    expect(relay).not.toHaveBeenCalled();
  });
});
