import type { CloudActor } from "../../../lib/cloud-contract";
import {
  canUseClient,
  type AgentAccess,
  type ClientUser,
} from "../../../lib/client-access";
import { canOpenSessions } from "../../../lib/fleet-session-routing";
import {
  startClientSession,
  type ClientSessionStart,
  type ClientSessionStarted,
} from "../../client-sessions";
import { collectFleetStatus } from "../../fleet-status";
import { getRuntime } from "../../runtime";
import { HttpError } from "../../errors";
import type { CloudPermission } from "../../../lib/cloud-permissions";
import { CloudError, requireMembership, type CloudAccess } from "../access";
import type { CloudDatabase, CloudSql } from "../database";

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

function clientUserOf(actor: CloudActor, access: CloudAccess): ClientUser {
  const can = (permission: CloudPermission) =>
    access.owner || access.permissions.has(permission);
  return {
    userId: actor.userId,
    manager: can("clients.manage"),
    startsTasks: can("ai.tasks"),
  };
}

export async function requireClientUse(
  sql: CloudSql,
  actor: CloudActor,
  instanceId: string,
): Promise<void> {
  const access = await requireMembership(sql, actor);
  const client = (
    await sql.query<{
      ownerUserId: string | null;
      agentAccess: AgentAccess;
      agentUsers: string[];
    }>(
      `SELECT owner_user_id::text AS "ownerUserId",agent_access AS "agentAccess",agent_users::text[] AS "agentUsers"
       FROM remote.instances WHERE instance_id=$1 AND revoked_at IS NULL`,
      [instanceId],
    )
  ).rows[0];
  if (!client || !canUseClient(clientUserOf(actor, access), client))
    throw new CloudError(
      403,
      "client_unavailable",
      "You can't start agent tasks on this client.",
    );
}

export class CloudClients {
  constructor(private readonly database: CloudDatabase) {}

  private clientUser(actor: CloudActor): Promise<ClientUser> {
    return this.database.transaction(async (sql) =>
      clientUserOf(actor, await requireMembership(sql, actor)),
    );
  }

  async list(
    actor: CloudActor,
    signal: AbortSignal,
  ): Promise<CloudClientDevice[]> {
    const status = await collectFleetStatus(
      getRuntime(),
      signal,
      await this.clientUser(actor),
    );
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
          authorize: () => this.clientUser(actor),
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
