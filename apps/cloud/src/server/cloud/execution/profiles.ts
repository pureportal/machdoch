import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  ExecutionCheck,
  ExecutionProfile,
  ExecutionProfileInput,
  ExecutionProfileUpdate,
  ExecutionRepository,
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
import type { CloudDatabase, CloudSql } from "../database";
import { fenceRun, lockExecution, readProfile, readRun } from "./records";
import { readInferenceProvider } from "../ai/budgets";
import { requireFetchableRepository } from "../git/repository-access";
import { gitConnection } from "../git/connections";
import { gitClient } from "../git/git-client";
import type { GitProvider } from "../../../lib/git-providers";
import type { SettingsCipher } from "../../settings-crypto";
import { detectRepositoryChecks } from "./check-detection";

async function requireSingleAutopilot(
  sql: CloudSql,
  actor: CloudActor,
  projectId: string,
  id: string,
  autopilot: boolean,
): Promise<void> {
  if (!autopilot) return;
  const other = await sql.query(
    "SELECT id FROM cloud_execution_profiles WHERE organization_id=$1 AND project_id=$2 AND id<>$3 AND (definition->>'autopilot')::boolean",
    [actor.organizationId, projectId, id],
  );
  if (other.rows.length)
    throw new CloudError(
      409,
      "autopilot_taken",
      "Another setup already runs Autopilot for this project. Turn it off there first.",
    );
}

export class CloudExecutionProfiles {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch,
  ) {}

  repositories(actor: CloudActor): Promise<ExecutionRepository[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      return (
        await sql.query<ExecutionRepository & Record<string, unknown>>(
          `SELECT web_url AS url,full_name AS "fullName",provider,default_branch AS "defaultBranch",private
          FROM cloud_git_repositories WHERE organization_id=$1 AND web_url IS NOT NULL ORDER BY lower(full_name)`,
          [actor.organizationId],
        )
      ).rows;
    });
  }

  async detectChecks(
    actor: CloudActor,
    repository: string,
    branch: string | null,
  ): Promise<ExecutionCheck[]> {
    const target = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      const row = (
        await sql.query<{
          provider: GitProvider;
          full_name: string;
          default_branch: string;
        }>(
          "SELECT provider,full_name,default_branch FROM cloud_git_repositories WHERE organization_id=$1 AND lower(web_url)=lower($2)",
          [actor.organizationId, repository.replace(/\.git$/u, "")],
        )
      ).rows[0];
      if (!row) return null;
      return {
        ...row,
        connection: await gitConnection(
          sql,
          this.cipher,
          actor.organizationId,
          row.provider,
        ),
      };
    });
    if (!target) return [];
    const client = gitClient(target.connection, this.transport);
    return detectRepositoryChecks((path) =>
      client.fileText(target.full_name, path, branch ?? target.default_branch),
    );
  }

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
      await requireMembership(sql, actor, "ai.manage");
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
          await requireFetchableRepository(
            sql,
            actor.organizationId,
            input.repository,
          );
          if (input.target !== "client") {
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
          }
          const id = randomUUID();
          await requireSingleAutopilot(
            sql,
            actor,
            input.projectId,
            id,
            input.autopilot,
          );
          await sql.query(
            "INSERT INTO cloud_execution_profiles (organization_id,id,project_id,team_id,name,definition,check_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [
              actor.organizationId,
              id,
              input.projectId,
              project.team_id,
              input.name,
              JSON.stringify(input),
              input.checkPullRequests ? actor.userId : null,
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
      await requireMembership(sql, actor, "ai.manage");
      const profile = await readProfile(sql, actor, id);
      return command(
        sql,
        actor,
        key,
        { kind: "execution_profile.update", id, input },
        async () => {
          checkRevision(profile.revision, input.revision);
          await requireFetchableRepository(
            sql,
            actor.organizationId,
            input.repository,
          );
          if (input.target !== "client") {
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
          }
          const { revision: expected, enabled, ...definition } = input;
          await requireSingleAutopilot(
            sql,
            actor,
            profile.projectId,
            id,
            input.autopilot,
          );
          await sql.query(
            "UPDATE cloud_execution_profiles SET name=$3,definition=$4,enabled=$5,check_actor_id=$6,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.name,
              JSON.stringify({ ...definition, projectId: profile.projectId }),
              enabled,
              input.checkPullRequests ? actor.userId : null,
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
