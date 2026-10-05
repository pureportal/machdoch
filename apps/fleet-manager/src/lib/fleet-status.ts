import type { HostTelemetry, ProductSnapshot } from "@machdoch/fleet-protocol";
import type { VersionStatus } from "./product-version";

export interface FleetDeviceStatus {
  instanceId: string;
  displayName: string;
  online: boolean;
  productVersion: string;
  versionStatus: VersionStatus;
  capturedAt: number | null;
  error: string | null;
  telemetry?: HostTelemetry;
  sessions: Array<
    Pick<
      NonNullable<ProductSnapshot["shell"]>["sessions"][number],
      | "id"
      | "title"
      | "status"
      | "workspace"
      | "provider"
      | "model"
      | "runningTaskId"
      | "updatedAt"
    >
  >;
  workspaces: Array<{ root: string; label: string; sessionCount: number }>;
  tasks: Array<
    Pick<
      ProductSnapshot["sessions"][number],
      "taskId" | "state" | "message" | "cancellable" | "updatedAt"
    >
  >;
  failures: Array<{ id: string; message: string; updatedAt: number }>;
}

export interface FleetStatus {
  capturedAt: number;
  managerVersion: string;
  devices: FleetDeviceStatus[];
}

export function summarizeProductSnapshot(
  snapshot: ProductSnapshot,
): Pick<
  FleetDeviceStatus,
  "capturedAt" | "telemetry" | "sessions" | "workspaces" | "tasks" | "failures"
> {
  const shell = snapshot.shell;
  const failures = snapshot.sessions
    .filter((task) => ["failed", "crashed", "error"].includes(task.state))
    .map((task) => ({
      id: task.taskId,
      message: task.message,
      updatedAt: task.updatedAt,
    }));
  if (shell?.runtime?.error)
    failures.push({
      id: "runtime",
      message: shell.runtime.error,
      updatedAt: shell.capturedAt,
    });
  if (shell?.ralph?.error)
    failures.push({
      id: "ralph",
      message: shell.ralph.error,
      updatedAt: shell.ralph.updatedAt,
    });
  for (const run of shell?.ralph?.runs ?? []) {
    if (run.status === "crashed")
      failures.push({
        id: `ralph/${run.id}`,
        message: run.summary,
        updatedAt: run.finishedAt ?? run.createdAt,
      });
  }
  return {
    capturedAt: snapshot.serverTime,
    ...(snapshot.telemetry ? { telemetry: snapshot.telemetry } : {}),
    sessions: (shell?.sessions ?? [])
      .filter((session) => session.archivedAt === undefined)
      .map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        ...(session.workspace ? { workspace: session.workspace } : {}),
        provider: session.provider,
        model: session.model,
        ...(session.runningTaskId
          ? { runningTaskId: session.runningTaskId }
          : {}),
        updatedAt: session.updatedAt,
      })),
    workspaces: shell?.workspaces ?? [],
    tasks: snapshot.sessions.map(
      ({ taskId, state, message, cancellable, updatedAt }) => ({
        taskId,
        state,
        message,
        cancellable,
        updatedAt,
      }),
    ),
    failures: failures
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 20),
  };
}
