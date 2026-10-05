import { productCommandSchema } from "@machdoch/fleet-protocol";
import { z } from "zod";
import type { FleetDeviceStatus } from "./fleet-status";

const instanceIdSchema = z.string().regex(/^instance_[A-Za-z0-9_-]{24}$/u);
const workspaceSchema = z
  .string()
  .trim()
  .refine(
    (workspace) =>
      productCommandSchema.safeParse({ kind: "create-session", workspace })
        .success,
  );

export const fleetSessionTargetSchema = z.strictObject({
  instanceId: instanceIdSchema,
  workspace: workspaceSchema,
});

export const fleetSessionRequestSchema = z.strictObject({
  commandId: z.string().uuid(),
  targets: z
    .array(fleetSessionTargetSchema)
    .min(1)
    .max(16)
    .refine(
      (targets) =>
        new Set(targets.map((target) => JSON.stringify(target))).size ===
        targets.length,
    ),
});

export const fleetSessionRouteSchema = fleetSessionTargetSchema.extend({
  commandId: z.string().uuid(),
  displayName: z.string(),
  sessionId: z.string().min(1).max(160),
});

export type FleetSessionTarget = z.infer<typeof fleetSessionTargetSchema>;
export type FleetSessionRequest = z.infer<typeof fleetSessionRequestSchema>;
export type FleetSessionRoute = z.infer<typeof fleetSessionRouteSchema>;

export function selectFleetSessionTarget(
  devices: FleetDeviceStatus[],
  targets: FleetSessionTarget[],
): FleetSessionTarget | null {
  const candidates = targets.flatMap((target) => {
    const device = devices.find(
      (entry) => entry.instanceId === target.instanceId,
    );
    if (
      !device?.online ||
      device.error !== null ||
      !device.canCreateSession ||
      device.versionStatus === "incompatible" ||
      !device.workspaces.some(
        (workspace) => workspace.root === target.workspace,
      )
    )
      return [];
    return [{ target, device }];
  });
  candidates.sort((left, right) => {
    const activeTasks = (device: FleetDeviceStatus): number =>
      device.tasks.filter((task) => task.cancellable).length;
    const memoryPressure = (device: FleetDeviceStatus): number => {
      const telemetry = device.telemetry;
      return telemetry && telemetry.memoryTotalBytes > 0
        ? telemetry.memoryUsedBytes / telemetry.memoryTotalBytes
        : 1;
    };
    return (
      activeTasks(left.device) - activeTasks(right.device) ||
      (left.device.telemetry?.cpuUsagePercent ?? 100) -
        (right.device.telemetry?.cpuUsagePercent ?? 100) ||
      memoryPressure(left.device) - memoryPressure(right.device) ||
      left.target.instanceId.localeCompare(right.target.instanceId) ||
      left.target.workspace.localeCompare(right.target.workspace)
    );
  });
  return candidates[0]?.target ?? null;
}
