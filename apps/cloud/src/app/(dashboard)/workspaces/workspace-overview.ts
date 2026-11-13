import type { FleetDeviceStatus } from "@/lib/fleet-status";

export type FleetWorkspace = FleetDeviceStatus["workspaces"][number];
export type FleetSession = FleetDeviceStatus["sessions"][number];
export type SessionTone = "running" | "success" | "failed" | "blocked" | "idle";

export interface DeviceOverview {
  device: FleetDeviceStatus;
  workspaces: FleetWorkspace[];
  sessions: FleetSession[];
  runningSessions: number;
}

const extendedPathPrefix = /^\\\\\?\\(UNC\\)?/u;

export function displayPath(root: string): string {
  return root.replace(extendedPathPrefix, (_, unc: string | undefined) =>
    unc ? "\\\\" : "",
  );
}

export function workspaceName(workspace: FleetWorkspace): string {
  const segments = displayPath(workspace.root).split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? workspace.label;
}

export function sessionTone(status: string): SessionTone {
  if (status === "running") return "running";
  if (status === "done" || status === "ready") return "success";
  if (status === "failed" || status === "timed-out") return "failed";
  if (status === "blocked") return "blocked";
  return "idle";
}

function sameWorkspace(left: string, right: string): boolean {
  return (
    displayPath(left).toLocaleLowerCase() ===
    displayPath(right).toLocaleLowerCase()
  );
}

export function sessionWorkspace(
  session: FleetSession,
  workspaces: FleetWorkspace[],
): FleetWorkspace | undefined {
  const root = session.workspace;
  return root === undefined
    ? undefined
    : workspaces.find((workspace) => sameWorkspace(workspace.root, root));
}

export function workspaceSessions(
  workspace: FleetWorkspace,
  sessions: FleetSession[],
): FleetSession[] {
  return sessions.filter(
    (session) =>
      session.workspace !== undefined &&
      sameWorkspace(session.workspace, workspace.root),
  );
}

export function overviewDevices(
  devices: FleetDeviceStatus[],
  query: string,
): DeviceOverview[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...values: Array<string | undefined>): boolean =>
    values.some((value) => value?.toLocaleLowerCase().includes(needle));
  return [...devices]
    .sort(
      (left, right) =>
        Number(right.online) - Number(left.online) ||
        left.displayName.localeCompare(right.displayName),
    )
    .flatMap((device) => {
      const sessions = [...device.sessions].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
      const runningSessions = sessions.filter(
        (session) => sessionTone(session.status) === "running",
      ).length;
      const workspaces = [...device.workspaces].sort((left, right) =>
        workspaceName(left).localeCompare(workspaceName(right)),
      );
      if (!needle || matches(device.displayName))
        return [{ device, workspaces, sessions, runningSessions }];
      const matchingWorkspaces = workspaces.filter((workspace) =>
        matches(workspace.label, displayPath(workspace.root)),
      );
      const matchingSessions = sessions.filter(
        (session) =>
          matches(session.title, session.provider, session.model) ||
          sessionWorkspace(session, matchingWorkspaces) !== undefined,
      );
      return matchingWorkspaces.length || matchingSessions.length
        ? [
            {
              device,
              workspaces: matchingWorkspaces,
              sessions: matchingSessions,
              runningSessions,
            },
          ]
        : [];
    });
}
