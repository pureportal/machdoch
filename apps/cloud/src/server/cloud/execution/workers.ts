import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  ExecutionWorker,
  ClientWorkspaceBinding,
  ExecutionProfile,
  ProjectClient,
} from "@machdoch/fleet-protocol/cloud-execution";
import { createSecret, hashSecret, validateSecret } from "../../crypto";
import {
  CloudError,
  command,
  recordEvent,
  requireMembership,
  teamVisibility,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { fenceRun, lockExecution, readProfile, readRun } from "./records";

export interface WorkerIdentity {
  organizationId: string;
  id: string;
  profileId: string;
  profileRevision: number;
  enabled: boolean;
  expired: boolean;
  target: ExecutionProfile["target"];
  workspaceBinding: ClientWorkspaceBinding | null;
}

export async function recordWorkerEvent(
  sql: CloudSql,
  worker: WorkerIdentity,
  kind: string,
  payload: unknown,
): Promise<void> {
  await sql.query(
    "INSERT INTO cloud_outbox (id,organization_id,worker_id,kind,subject_id,revision,payload) VALUES ($1,$2,$3,$4,$3,1,$5)",
    [
      randomUUID(),
      worker.organizationId,
      worker.id,
      kind,
      JSON.stringify(payload),
    ],
  );
}

export async function requireWorker(
  sql: CloudSql,
  token: string,
): Promise<WorkerIdentity> {
  if (!validateSecret(token, "mch_cloud_worker"))
    throw new CloudError(
      401,
      "runner_authentication",
      "Runner credentials are invalid.",
    );
  const parameters = [hashSecret(token)];
  const reference = (
    await sql.query<{ organization_id: string }>(
      "SELECT organization_id FROM cloud_execution_workers WHERE token_hash=$1",
      parameters,
    )
  ).rows[0];
  if (!reference)
    throw new CloudError(
      401,
      "runner_authentication",
      "Runner credentials are invalid.",
    );
  await lockExecution(sql, reference.organization_id);
  const worker = (
    await sql.query<WorkerIdentity & Record<string, unknown>>(
      `SELECT w.organization_id AS "organizationId",w.id,w.profile_id AS "profileId",w.profile_revision AS "profileRevision",w.enabled,w.expires_at<=clock_timestamp() AS expired,
      p.definition->>'target' AS target,w.workspace_binding AS "workspaceBinding"
    FROM cloud_execution_workers w JOIN cloud_execution_profiles p ON p.organization_id=w.organization_id AND p.id=w.profile_id WHERE w.token_hash=$1 FOR SHARE OF w`,
      parameters,
    )
  ).rows[0];
  if (!worker)
    throw new CloudError(
      401,
      "runner_authentication",
      "Runner credentials are invalid.",
    );
  return worker;
}

export class CloudWorkers {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, profileId: string): Promise<ExecutionWorker[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      await readProfile(sql, actor, profileId);
      return (
        await sql.query<ExecutionWorker & Record<string, unknown>>(
          `SELECT id,profile_id AS "profileId",name,enabled,workspace_binding AS "workspaceBinding",
        to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
        to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
        FROM cloud_execution_workers WHERE organization_id=$1 AND profile_id=$2 ORDER BY name,id`,
          [actor.organizationId, profileId],
        )
      ).rows;
    });
  }

  listForProject(
    actor: CloudActor,
    projectId: string,
  ): Promise<ProjectClient[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const rows = (
        await sql.query<{
          id: string;
          name: string;
          workspace_name: string | null;
          online: boolean;
          profile_id: string;
          definition: ExecutionProfile;
          team_id: string;
          revision: number;
        }>(
          `SELECT w.id,w.name,w.workspace_binding->>'name' AS workspace_name,
        COALESCE(w.last_seen_at>clock_timestamp()-interval '2 minutes',false) AS online,
        p.id AS profile_id,p.definition,p.team_id,p.revision
        FROM cloud_execution_workers w
        JOIN cloud_execution_profiles p ON p.organization_id=w.organization_id AND p.id=w.profile_id
        JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
        JOIN cloud_memberships m ON m.organization_id=w.organization_id AND m.user_id=$2
        WHERE w.organization_id=$1 AND ${teamVisibility} AND p.project_id=$3 AND p.enabled AND p.definition->>'target'<>'cloud'
        AND w.enabled AND w.profile_revision=p.revision AND w.expires_at>clock_timestamp()
        ORDER BY w.name,w.id LIMIT 50`,
          [actor.organizationId, actor.userId, projectId],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        workspaceName: row.workspace_name,
        online: row.online,
        profile: {
          ...row.definition,
          id: row.profile_id,
          teamId: row.team_id,
          projectId,
          revision: row.revision,
          enabled: true,
        },
      }));
    });
  }

  register(
    actor: CloudActor,
    profileId: string,
    name: string,
  ): Promise<{ id: string; token: string }> {
    const token = createSecret("mch_cloud_worker");
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const profile = await readProfile(sql, actor, profileId);
      if (!profile.enabled)
        throw new CloudError(
          409,
          "profile_disabled",
          "Enable the execution profile before enrolling a runner.",
        );
      const id = randomUUID();
      await sql.query(
        "INSERT INTO cloud_execution_workers (organization_id,id,profile_id,profile_revision,name,token_hash) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          actor.organizationId,
          id,
          profileId,
          profile.revision,
          name,
          hashSecret(token),
        ],
      );
      await recordEvent(sql, actor, "runner.enrolled", id, 1, { profileId });
      return { id, token };
    });
  }

  revoke(actor: CloudActor, key: string, id: string): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const worker = (
        await sql.query<{ profile_id: string }>(
          "SELECT profile_id FROM cloud_execution_workers WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!worker)
        throw new CloudError(404, "not_found", "Runner is unavailable.");
      await readProfile(sql, actor, worker.profile_id);
      return command(
        sql,
        actor,
        key,
        { kind: "runner.revoke", id },
        async () => {
          await sql.query(
            "UPDATE cloud_execution_workers SET enabled=false WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id],
          );
          const attempts = await sql.query<{ run_id: string }>(
            "SELECT run_id FROM cloud_run_attempts WHERE organization_id=$1 AND worker_id=$2 AND state<>'stopped'",
            [actor.organizationId, id],
          );
          for (const attempt of attempts.rows)
            await fenceRun(
              sql,
              actor.organizationId,
              await readRun(sql, actor.organizationId, attempt.run_id),
              "failed",
              "Runner access revoked",
            );
          await recordEvent(sql, actor, "runner.revoked", id, 1, {});
          return { id };
        },
      );
    });
  }

  rotate(
    actor: CloudActor,
    id: string,
  ): Promise<{ id: string; token: string }> {
    const token = createSecret("mch_cloud_worker");
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const worker = (
        await sql.query<{ profile_id: string }>(
          "SELECT profile_id FROM cloud_execution_workers WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!worker)
        throw new CloudError(404, "not_found", "Runner is unavailable.");
      const profile = await readProfile(sql, actor, worker.profile_id);
      if (!profile.enabled)
        throw new CloudError(
          409,
          "profile_disabled",
          "Enable the execution profile before rotating the runner token.",
        );
      const attempts = await sql.query<{ run_id: string }>(
        "SELECT run_id FROM cloud_run_attempts WHERE organization_id=$1 AND worker_id=$2 AND state<>'stopped'",
        [actor.organizationId, id],
      );
      for (const attempt of attempts.rows)
        await fenceRun(
          sql,
          actor.organizationId,
          await readRun(sql, actor.organizationId, attempt.run_id),
          "failed",
          "Runner credentials rotated",
        );
      await sql.query(
        "UPDATE cloud_execution_workers SET token_hash=$3,enabled=true,profile_revision=$4,last_seen_at=NULL,expires_at=clock_timestamp()+interval '30 days' WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id, hashSecret(token), profile.revision],
      );
      await recordEvent(sql, actor, "runner.token_rotated", id, 1, {});
      return { id, token };
    });
  }
}
