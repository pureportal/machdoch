import type { AgentAccess } from "@/lib/client-access";
import type { VersionStatus } from "@/lib/product-version";

export interface FleetInstance {
  instanceId: string;
  displayName: string;
  productVersion: string;
  protocolVersion: number;
  enrolledAt: number;
  lastSeenAt: number | null;
  status: "online" | "offline" | "revoked";
  remoteUpdate: boolean;
  versionStatus?: VersionStatus;
  managerVersion?: string;
  ownerUserId: string | null;
  ownerName: string | null;
  agentAccess: AgentAccess;
  agentUsers: string[];
  mine: boolean;
  usable: boolean;
}

export const agentAccessLabels: Record<AgentAccess, string> = {
  admins: "Only admins",
  everyone: "Everyone",
  people: "Selected people",
};

export function clientOwner(device: FleetInstance): string {
  if (device.mine) return "You";
  if (device.ownerUserId) return device.ownerName ?? "Former member";
  return "Organization";
}

export function clientAccessSummary(device: FleetInstance): string {
  if (device.ownerUserId) return clientOwner(device);
  const access =
    device.agentAccess === "people"
      ? `${device.agentUsers.length} ${device.agentUsers.length === 1 ? "person" : "people"}`
      : agentAccessLabels[device.agentAccess];
  return `Organization · Agent tasks: ${access}`;
}

export type DeviceFilter = "active" | FleetInstance["status"];
export type DeviceSort = "status" | "name" | "last-seen" | "enrolled";

export function summarizeFleet(instances: FleetInstance[]): {
  active: number;
  online: number;
  offline: number;
  revoked: number;
} {
  const summary = { active: 0, online: 0, offline: 0, revoked: 0 };
  for (const instance of instances) {
    summary[instance.status] += 1;
    if (instance.status !== "revoked") summary.active += 1;
  }
  return summary;
}

export function selectDevices(
  instances: FleetInstance[],
  query: string,
  status: DeviceFilter,
  sort: DeviceSort,
): FleetInstance[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const statusOrder = { offline: 0, online: 1, revoked: 2 };
  return instances
    .filter(
      (instance) =>
        (status === "active"
          ? instance.status !== "revoked"
          : instance.status === status) &&
        `${instance.displayName} ${instance.instanceId} ${instance.productVersion} ${clientOwner(instance)}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
    )
    .sort((left, right) => {
      let difference = 0;
      if (sort === "status") {
        difference = statusOrder[left.status] - statusOrder[right.status];
        if (!difference && left.status === "offline")
          difference = (left.lastSeenAt ?? 0) - (right.lastSeenAt ?? 0);
      } else if (sort === "last-seen") {
        difference = (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0);
      } else if (sort === "enrolled") {
        difference = right.enrolledAt - left.enrolledAt;
      }
      return (
        difference ||
        left.displayName.localeCompare(right.displayName, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        left.instanceId.localeCompare(right.instanceId)
      );
    });
}
