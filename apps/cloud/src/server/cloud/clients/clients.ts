import type { CloudActor } from "../../../lib/cloud-contract";
import { canOpenSessions } from "../../../lib/fleet-session-routing";
import {
  startClientSession,
  type ClientSessionStart,
  type ClientSessionStarted,
} from "../../client-sessions";
import { collectFleetStatus } from "../../fleet-status";
import { getRuntime } from "../../runtime";
import { HttpError } from "../../errors";
import { CloudError, requireMembership } from "../access";
import type { CloudDatabase } from "../database";

export interface CloudClientDevice {
  instanceId: string;
  name: string;
  workspaces: { root: string; label: string }[];
}

export function clientSessionHref(session: {
  instanceId: string;
  sessionId: string;
}): string {
  return `/instances/${encodeURIComponent(session.instanceId)}?session=${encodeURIComponent(session.sessionId)}`;
}

export class CloudClients {
  constructor(private readonly database: CloudDatabase) {}

  private requireAdministrator(actor: CloudActor): Promise<unknown> {
    return this.database.transaction((sql) =>
      requireMembership(sql, actor, "admin"),
    );
  }

  async list(
    actor: CloudActor,
    signal: AbortSignal,
  ): Promise<CloudClientDevice[]> {
    await this.requireAdministrator(actor);
    const status = await collectFleetStatus(getRuntime(), signal);
    return status.devices.filter(canOpenSessions).map((device) => ({
      instanceId: device.instanceId,
      name: device.displayName,
      workspaces: device.workspaces.map((workspace) => ({
        root: workspace.root,
        label: workspace.label,
      })),
    }));
  }

  async start(
    actor: CloudActor,
    commandId: string,
    input: ClientSessionStart,
    signal: AbortSignal,
  ): Promise<ClientSessionStarted> {
    try {
      return await startClientSession(
        getRuntime(),
        {
          authorize: async () => {
            await this.requireAdministrator(actor);
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
        commandId,
        input,
      );
    } catch (error) {
      if (error instanceof HttpError)
        throw new CloudError(409, "client_unavailable", error.message);
      throw error;
    }
  }
}
