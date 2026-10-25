import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  ExecutionProfile,
  ExecutionProfileInput,
  ExecutionProfileUpdate,
} from "@machdoch/fleet-protocol/cloud-execution";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "../access";
import type { CloudDatabase } from "../database";
import { fenceRun, lockExecution, readProfile, readRun } from "./records";
import { readInferenceProvider } from "../ai/budgets";

export class CloudExecutionProfiles {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, projectId?: string): Promise<ExecutionProfile[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const rows = (
        await sql.query<{
          id: string;
          team_id: string;
          project_id: string;
          revision: number;
          enabled: boolean;
          definition: ExecutionProfileInput;
        }>(
          `SELECT p.id,p.team_id,p.project_id,p.revision,p.enabled,p.definition FROM cloud_execution_profiles p
        JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
        WHERE p.organization_id=$1 AND ${teamVisibility} AND ($3::uuid IS NULL OR p.project_id=$3) ORDER BY p.name,p.id`,
          [actor.organizationId, actor.userId, projectId ?? null],
        )
      ).rows;
      return rows.map((row) => ({
        ...row.definition,
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        revision: row.revision,
        enabled: row.enabled,
      }));
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: ExecutionProfileInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const project = (
        await sql.query<{ team_id: string }>(
          "SELECT team_id FROM cloud_projects WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, input.projectId],
        )
      ).rows[0];
      if (!project)
        throw new CloudError(404, "not_found", "Project is unavailable.");
      await requireTeam(sql, actor, project.team_id);
      return command(
        sql,
        actor,
        key,
        { kind: "execution_profile.create", input },
        async () => {
          const provider = await readInferenceProvider(
            sql,
            actor.organizationId,
            input.providerId,
          );
          if (!provider.models.includes(input.model))
            throw new CloudError(
              422,
              "model_unavailable",
              "Choose a configured model for this provider.",
            );
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_execution_profiles (organization_id,id,project_id,team_id,name,definition) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              actor.organizationId,
              id,
              input.projectId,
              project.team_id,
              input.name,
              JSON.stringify(input),
            ],
          );
          await recordEvent(sql, actor, "execution_profile.created", id, 1, {});
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: ExecutionProfileUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      const profile = await readProfile(sql, actor, id);
      return command(
        sql,
        actor,
        key,
        { kind: "execution_profile.update", id, input },
        async () => {
          checkRevision(profile.revision, input.revision);
          const provider = await readInferenceProvider(
            sql,
            actor.organizationId,
            input.providerId,
            !input.enabled,
          );
          if (input.enabled && !provider.models.includes(input.model))
            throw new CloudError(
              422,
              "model_unavailable",
              "Choose a configured model for this provider.",
            );
          const { revision: expected, enabled, ...definition } = input;
          await sql.query(
            "UPDATE cloud_execution_profiles SET name=$3,definition=$4,enabled=$5,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.name,
              JSON.stringify({ ...definition, projectId: profile.projectId }),
              enabled,
            ],
          );
          await sql.query(
            "UPDATE cloud_execution_workers SET enabled=false WHERE organization_id=$1 AND profile_id=$2",
            [actor.organizationId, id],
          );
          const runs = await sql.query<{ id: string }>(
            "SELECT id FROM cloud_runs WHERE organization_id=$1 AND profile_id=$2 AND state NOT IN ('succeeded','failed','canceled','timed_out') ORDER BY id",
            [actor.organizationId, id],
          );
          for (const run of runs.rows)
            await fenceRun(
              sql,
              actor.organizationId,
              await readRun(sql, actor.organizationId, run.id),
              "failed",
              "Execution profile changed",
            );
          await recordEvent(
            sql,
            actor,
            "execution_profile.changed",
            id,
            expected + 1,
            { enabled },
          );
          return { id };
        },
      );
    });
  }
}
