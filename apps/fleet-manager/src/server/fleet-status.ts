import {
  gatewayProtocolVersion,
  productSnapshotSchema,
} from "@machdoch/fleet-protocol";
import packageJson from "../../package.json";
import {
  summarizeProductSnapshot,
  type FleetDeviceStatus,
  type FleetStatus,
} from "../lib/fleet-status";
import { productVersionStatus } from "../lib/product-version";
import { GatewayError } from "./gateway";
import type { FleetRuntime } from "./runtime";

export async function collectFleetStatus(
  runtime: FleetRuntime,
  requestSignal: AbortSignal,
  instanceIds?: ReadonlySet<string>,
): Promise<FleetStatus> {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(8_000)]);
  const instances = runtime.fleetStore
    .listInstances()
    .filter(
      (instance) =>
        instance.revokedAt === null &&
        (!instanceIds || instanceIds.has(instance.instanceId)),
    );
  const devices: FleetDeviceStatus[] = instances.map((instance) => ({
    instanceId: instance.instanceId,
    displayName: instance.displayName,
    online: runtime.gateways.isOnline(instance.instanceId),
    productVersion: instance.productVersion,
    versionStatus: productVersionStatus(
      instance.productVersion,
      packageJson.version,
      instance.protocolVersion,
      gatewayProtocolVersion,
    ),
    capturedAt: null,
    error: null,
    canCreateSession: false,
    sessions: [],
    workspaces: [],
    tasks: [],
    failures: [],
  }));
  let cursor = 0;
  const collect = async (): Promise<void> => {
    while (cursor < devices.length) {
      const device = devices[cursor++]!;
      if (!device.online) continue;
      if (signal.aborted) {
        device.error = "Device status timed out. Refresh to try again.";
        continue;
      }
      try {
        const response = await runtime.gateways.relay(
          device.instanceId,
          { type: "getProductSnapshot" },
          signal,
        );
        if (response.type === "error") throw new Error(response.message);
        if (response.type !== "productSnapshot")
          throw new Error("Device returned invalid status data.");
        const snapshot = productSnapshotSchema.safeParse(response.snapshot);
        if (!snapshot.success)
          throw new Error(
            "Update this device to provide compatible status data.",
          );
        Object.assign(device, summarizeProductSnapshot(snapshot.data));
      } catch (reason) {
        device.error =
          reason instanceof GatewayError
            ? "Device status is unavailable. Refresh to try again."
            : reason instanceof Error
              ? reason.message
              : "Device status could not be loaded.";
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, devices.length) }, collect),
  );
  requestSignal.throwIfAborted();
  return {
    capturedAt: Date.now(),
    managerVersion: packageJson.version,
    devices: devices.filter(
      (device) =>
        runtime.fleetStore.getInstance(device.instanceId)?.revokedAt === null,
    ),
  };
}
