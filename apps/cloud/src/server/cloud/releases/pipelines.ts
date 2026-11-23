import { randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudPipeline,
  CreatedPipeline,
  PipelineInput,
  PipelineSummary,
  PipelineUpdate,
} from "../../../lib/cloud-release-pipeline-contract";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "../access";
import { hashWebhookToken } from "../automation/automations";
import type { CloudDatabase, CloudSql } from "../database";

export const pipelineTimestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const visiblePipeline = `EXISTS (SELECT 1 FROM cloud_release_pipeline_teams pt JOIN cloud_teams t ON t.organization_id=pt.organization_id AND t.id=pt.team_id
  JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
  WHERE pt.organization_id=p.organization_id AND pt.pipeline_id=p.id AND ${teamVisibility})`;

const summaryColumns = `p.id,p.name,p.type,p.source,p.archived,r.full_name AS repository,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'key',t.key) ORDER BY t.name) FROM cloud_release_pipeline_teams pt
    JOIN cloud_teams t ON t.organization_id=pt.organization_id AND t.id=pt.team_id JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
    WHERE pt.organization_id=p.organization_id AND pt.pipeline_id=p.id AND ${teamVisibility}),'[]'::jsonb) AS teams,
  COALESCE((SELECT array_agg(e.name ORDER BY e.position) FROM cloud_release_pipeline_environments e WHERE e.organization_id=p.organization_id AND e.pipeline_id=p.id),'{}') AS environments,
  (SELECT count(*)::integer FROM cloud_pipeline_releases x WHERE x.organization_id=p.organization_id AND x.pipeline_id=p.id) AS "releaseCount",
  (SELECT jsonb_build_object('id',x.id,'version',x.version,'environment',x.environment,'deployedAt',${pipelineTimestamp("x.deployed_at")})
    FROM cloud_pipeline_releases x WHERE x.organization_id=p.organization_id AND x.pipeline_id=p.id ORDER BY x.deployed_at DESC,x.id LIMIT 1) AS "latestRelease"`;
const summaryFrom = `cloud_release_pipelines p LEFT JOIN cloud_git_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id`;

async function requireDefinitionTargets(
  sql: CloudSql,
  actor: CloudActor,
  input: PipelineInput,
): Promise<void> {
  const teamIds = [...new Set(input.teamIds)];
  const visible = (
    await sql.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
      WHERE t.organization_id=$1 AND t.id=ANY($3::uuid[]) AND ${teamVisibility}`,
      [actor.organizationId, actor.userId, teamIds],
    )
  ).rows[0]!.count;
  if (visible !== teamIds.length)
    throw new CloudError(404, "not_found", "Team is unavailable.");
  if (!input.repositoryId) return;
  const repository = await sql.query(
    "SELECT 1 FROM cloud_git_repositories WHERE organization_id=$1 AND id=$2",
    [actor.organizationId, input.repositoryId],
  );
  if (!repository.rows.length)
    throw new CloudError(404, "not_found", "Repository is unavailable.");
}

async function writeDefinition(
  sql: CloudSql,
  organizationId: string,
  pipelineId: string,
  input: PipelineInput,
): Promise<void> {
  await sql.query(
    "DELETE FROM cloud_release_pipeline_teams WHERE organization_id=$1 AND pipeline_id=$2",
    [organizationId, pipelineId],
  );
  await sql.query(
    "INSERT INTO cloud_release_pipeline_teams (organization_id,pipeline_id,team_id) SELECT DISTINCT $1::uuid,$2::uuid,unnest($3::uuid[])",
    [organizationId, pipelineId, input.teamIds],
  );
  await sql.query(
    "DELETE FROM cloud_release_pipeline_paths WHERE organization_id=$1 AND pipeline_id=$2",
    [organizationId, pipelineId],
  );
  await sql.query(
    "INSERT INTO cloud_release_pipeline_paths (organization_id,pipeline_id,pattern) SELECT DISTINCT $1::uuid,$2::uuid,unnest($3::text[])",
    [organizationId, pipelineId, input.paths],
  );
  await sql.query(
    "DELETE FROM cloud_release_pipeline_environments WHERE organization_id=$1 AND pipeline_id=$2 AND NOT name=ANY($3::text[])",
    [organizationId, pipelineId, input.environments],
  );
  await sql.query(
    `INSERT INTO cloud_release_pipeline_environments (organization_id,pipeline_id,name,position)
    SELECT $1,$2,e.name,e.ordinal-1 FROM unnest($3::text[]) WITH ORDINALITY AS e(name,ordinal)
    ON CONFLICT (organization_id,pipeline_id,name) DO UPDATE SET position=excluded.position`,
    [organizationId, pipelineId, input.environments],
  );
}

function newWebhookToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashWebhookToken(token) };
}

export async function readVisiblePipeline(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  lock = false,
): Promise<{
  id: string;
  name: string;
  source: string;
  revision: number;
  webhookConfigured: boolean;
}> {
  const row = (
    await sql.query<{
      id: string;
      name: string;
      source: string;
      revision: number;
      webhookConfigured: boolean;
    }>(
      `SELECT p.id,p.name,p.source,p.revision,p.webhook_hash IS NOT NULL AS "webhookConfigured" FROM cloud_release_pipelines p
      WHERE p.organization_id=$1 AND p.id=$3 AND ${visiblePipeline}${lock ? " FOR UPDATE OF p" : ""}`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!row) throw new CloudError(404, "not_found", "Pipeline is unavailable.");
  return row;
}

export class CloudReleasePipelines {
  constructor(private readonly database: CloudDatabase) {}

  list(
    actor: CloudActor,
    filters: { query: string; archived: boolean },
  ): Promise<PipelineSummary[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.view");
      return (
        await sql.query<PipelineSummary & Record<string, unknown>>(
          `SELECT ${summaryColumns} FROM ${summaryFrom}
          WHERE p.organization_id=$1 AND p.archived=$3 AND ($4='' OR p.name ILIKE '%'||$4||'%') AND ${visiblePipeline}
          ORDER BY lower(p.name),p.id`,
          [
            actor.organizationId,
            actor.userId,
            filters.archived,
            filters.query.trim().replace(/[\\%_]/gu, "\\$&"),
          ],
        )
      ).rows;
    });
  }

  get(actor: CloudActor, id: string): Promise<CloudPipeline> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.view");
      const pipeline = (
        await sql.query<
          Omit<CloudPipeline, "releases"> & Record<string, unknown>
        >(
          `SELECT ${summaryColumns},p.repository_id AS "repositoryId",p.revision,
          COALESCE((SELECT array_agg(pattern ORDER BY pattern) FROM cloud_release_pipeline_paths x WHERE x.organization_id=p.organization_id AND x.pipeline_id=p.id),'{}') AS paths
          FROM ${summaryFrom} WHERE p.organization_id=$1 AND p.id=$3 AND ${visiblePipeline}`,
          [actor.organizationId, actor.userId, id],
        )
      ).rows[0];
      if (!pipeline)
        throw new CloudError(404, "not_found", "Pipeline is unavailable.");
      const releases = (
        await sql.query<
          CloudPipeline["releases"][number] & Record<string, unknown>
        >(
          `SELECT x.id,x.version,x.environment,${pipelineTimestamp("x.deployed_at")} AS "deployedAt",x.from_sha AS "fromSha",x.to_sha AS "toSha",x.evidence_url AS "evidenceUrl",
          (SELECT count(*)::integer FROM cloud_pipeline_release_issues ri WHERE ri.organization_id=x.organization_id AND ri.release_id=x.id AND NOT ri.excluded) AS "issueCount"
          FROM cloud_pipeline_releases x WHERE x.organization_id=$1 AND x.pipeline_id=$2 ORDER BY x.deployed_at DESC,x.id LIMIT 200`,
          [actor.organizationId, id],
        )
      ).rows;
      return { ...pipeline, releases };
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: PipelineInput,
  ): Promise<CreatedPipeline> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      return command(
        sql,
        actor,
        key,
        { kind: "release_pipeline.create", input },
        async () => {
          await requireDefinitionTargets(sql, actor, input);
          const id = randomUUID();
          const webhook = input.source === "webhook" ? newWebhookToken() : null;
          await sql.query(
            "INSERT INTO cloud_release_pipelines (organization_id,id,name,repository_id,type,source,webhook_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              actor.organizationId,
              id,
              input.name,
              input.repositoryId,
              input.type,
              input.source,
              webhook?.hash ?? null,
              actor.userId,
            ],
          );
          await writeDefinition(sql, actor.organizationId, id, input);
          await recordEvent(sql, actor, "release_pipeline.created", id, 1, {
            name: input.name,
          });
          return { id, webhookToken: webhook?.token ?? null };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: PipelineUpdate,
  ): Promise<CreatedPipeline> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      return command(
        sql,
        actor,
        key,
        { kind: "release_pipeline.update", id, input },
        async () => {
          const current = await readVisiblePipeline(sql, actor, id, true);
          checkRevision(current.revision, input.revision);
          await requireDefinitionTargets(sql, actor, input);
          const webhook =
            input.source === "webhook" && !current.webhookConfigured
              ? newWebhookToken()
              : null;
          await sql.query(
            `UPDATE cloud_release_pipelines SET name=$3,repository_id=$4,type=$5,source=$6,archived=$7,revision=revision+1,
            webhook_hash=CASE WHEN $6='webhook' THEN COALESCE($8,webhook_hash) ELSE NULL END WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              input.name,
              input.repositoryId,
              input.type,
              input.source,
              input.archived,
              webhook?.hash ?? null,
            ],
          );
          await writeDefinition(sql, actor.organizationId, id, input);
          await recordEvent(
            sql,
            actor,
            "release_pipeline.updated",
            id,
            input.revision + 1,
            { name: input.name, archived: input.archived },
          );
          return { id, webhookToken: webhook?.token ?? null };
        },
      );
    });
  }

  rotateWebhook(actor: CloudActor, id: string): Promise<CreatedPipeline> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      const current = await readVisiblePipeline(sql, actor, id, true);
      if (current.source !== "webhook")
        throw new CloudError(
          409,
          "webhook_unavailable",
          "Only webhook pipelines have a secret.",
        );
      const webhook = newWebhookToken();
      await sql.query(
        "UPDATE cloud_release_pipelines SET webhook_hash=$3 WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id, webhook.hash],
      );
      return { id, webhookToken: webhook.token };
    });
  }

  releasePolicy(actor: CloudActor, teamId: string): Promise<boolean> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, teamId);
      return (
        await sql.query<{ enabled: boolean }>(
          "SELECT complete_issues_on_release AS enabled FROM cloud_teams WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, teamId],
        )
      ).rows[0]!.enabled;
    });
  }

  setReleasePolicy(
    actor: CloudActor,
    teamId: string,
    enabled: boolean,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      const team = await requireTeam(sql, actor, teamId, "teams.manage");
      await sql.query(
        "UPDATE cloud_teams SET complete_issues_on_release=$3 WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, teamId, enabled],
      );
      await recordEvent(
        sql,
        actor,
        "team.release_policy",
        teamId,
        team.revision,
        { completeOnRelease: enabled },
      );
    });
  }
}
