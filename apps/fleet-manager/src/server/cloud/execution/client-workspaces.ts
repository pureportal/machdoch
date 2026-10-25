import type {
  ClientWorkspaceBinding,
  ExecutionProfile,
  WorkerRegistration,
} from "@machdoch/fleet-protocol/cloud-execution";
import { CloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import {
  requireWorker,
  recordWorkerEvent,
  type WorkerIdentity,
} from "./workers";
import { fenceRun, readRun } from "./records";

async function registration(
  sql: CloudSql,
  worker: WorkerIdentity,
): Promise<WorkerRegistration> {
  const profile = (
    await sql.query<{
      definition: ExecutionProfile;
      revision: number;
      enabled: boolean;
      team_id: string;
      project_id: string;
      project_name: string;
    }>(
      `SELECT p.definition,p.revision,p.enabled,p.team_id,p.project_id,j.name AS project_name FROM cloud_execution_profiles p
    JOIN cloud_projects j ON j.organization_id=p.organization_id AND j.id=p.project_id
    WHERE p.organization_id=$1 AND p.id=$2`,
      [worker.organizationId, worker.profileId],
    )
  ).rows[0]!;
  if (
    !worker.enabled ||
    worker.expired ||
    !profile.enabled ||
    profile.revision !== worker.profileRevision
  )
    throw new CloudError(
      403,
      "runner_revoked",
      "Runner access has ended. Enroll a new runner.",
    );
  return {
    workerId: worker.id,
    organizationId: worker.organizationId,
    projectName: profile.project_name,
    profile: {
      ...profile.definition,
      id: worker.profileId,
      teamId: profile.team_id,
      projectId: profile.project_id,
      revision: profile.revision,
      enabled: profile.enabled,
    },
    workspaceBinding: worker.workspaceBinding,
  };
}

export class CloudClientWorkspaces {
  constructor(private readonly database: CloudDatabase) {}

  registration(token: string): Promise<WorkerRegistration> {
    return this.database.transaction(async (sql) =>
      registration(sql, await requireWorker(sql, token)),
    );
  }

  bind(
    token: string,
    binding: ClientWorkspaceBinding,
  ): Promise<WorkerRegistration> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const current = await registration(sql, worker);
      if (current.profile.target === "cloud")
        throw new CloudError(
          422,
          "client_profile_required",
          "Choose an execution profile that targets a client.",
        );
      if (binding.repository !== current.profile.repository)
        throw new CloudError(
          409,
          "repository_mismatch",
          "This workspace belongs to another repository. Choose the matching workspace.",
        );
      if (worker.workspaceBinding) {
        const previous = worker.workspaceBinding;
        if (
          previous.workspaceId !== binding.workspaceId ||
          previous.name !== binding.name ||
          previous.repository !== binding.repository
        )
          throw new CloudError(
            409,
            "workspace_already_linked",
            "This runner is linked to another workspace. Enroll a new runner to change it.",
          );
        await sql.query(
          "UPDATE cloud_execution_workers SET last_seen_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
          [worker.organizationId, worker.id],
        );
        return current;
      }
      await sql.query(
        "UPDATE cloud_execution_workers SET workspace_binding=$3,last_seen_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, worker.id, JSON.stringify(binding)],
      );
      await recordWorkerEvent(sql, worker, "runner.workspace_linked", {
        profileId: worker.profileId,
        workspaceId: binding.workspaceId,
      });
      return { ...current, workspaceBinding: binding };
    });
  }

  disconnect(token: string): Promise<{ disabled: true }> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      if (!worker.enabled) return { disabled: true };
      await sql.query(
        "UPDATE cloud_execution_workers SET enabled=false WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, worker.id],
      );
      const attempts = await sql.query<{ run_id: string }>(
        "SELECT run_id FROM cloud_run_attempts WHERE organization_id=$1 AND worker_id=$2 AND state<>'stopped' ORDER BY run_id",
        [worker.organizationId, worker.id],
      );
      for (const attempt of attempts.rows)
        await fenceRun(
          sql,
          worker.organizationId,
          await readRun(sql, worker.organizationId, attempt.run_id),
          "failed",
          "Runner disconnected",
        );
      await recordWorkerEvent(sql, worker, "runner.disconnected", {});
      return { disabled: true };
    });
  }
}
