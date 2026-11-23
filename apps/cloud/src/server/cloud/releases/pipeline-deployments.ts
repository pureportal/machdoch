import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { PipelineDeployment } from "../../../lib/cloud-release-pipeline-contract";
import { pullRequestReferences } from "../../../lib/git-links";
import { touchesPaths } from "../../../lib/release-pipeline-paths";
import { CloudError, isCloudError, recordEvent } from "../access";
import { derivedCommandId } from "../command-ids";
import type { CloudDatabase, CloudSql } from "../database";
import { queueAutomationEvents } from "../automation/automation-events";
import type { StoredRepository } from "../git/events";
import type { GitClient } from "../git/git-client";
import type { DeploymentEvent } from "../git/webhook-payloads";
import type { CloudIssueChanges } from "../issue-changes";

interface PipelineTarget {
  id: string;
  name: string;
  organizationId: string;
  createdBy: string;
  createdAt: Date;
  repositoryId: string | null;
  paths: string[];
  environments: string[];
}

interface ReleaseWindow {
  environment: string;
  last: boolean;
  fromSha: string | null;
  since: Date;
}

interface DeployedVersion {
  version: string;
  sha: string | null;
  externalId: string;
  url: string | null;
}

interface ReleaseLinks {
  pullRequestIds: string[];
  messages: string[];
}

const pipelineColumns = `p.id,p.name,p.organization_id AS "organizationId",p.created_by AS "createdBy",p.created_at AS "createdAt",p.repository_id AS "repositoryId",
  COALESCE((SELECT array_agg(pattern ORDER BY pattern) FROM cloud_release_pipeline_paths x WHERE x.organization_id=p.organization_id AND x.pipeline_id=p.id),'{}') AS paths,
  COALESCE((SELECT array_agg(name ORDER BY position) FROM cloud_release_pipeline_environments e WHERE e.organization_id=p.organization_id AND e.pipeline_id=p.id),'{}') AS environments`;

const pullRequestNumberPattern = /(?<![\w/])#(\d{1,9})\b/gu;

function resolveEnvironment(
  environments: readonly string[],
  requested: string | null,
): string | null {
  if (requested === null) return environments.at(-1) ?? null;
  const name = requested.trim().toLowerCase();
  return (
    environments.find((environment) => environment.toLowerCase() === name) ??
    null
  );
}

async function releaseWindow(
  sql: CloudSql,
  pipeline: PipelineTarget,
  requestedEnvironment: string | null,
  externalId: string,
): Promise<ReleaseWindow | null> {
  const environment = resolveEnvironment(
    pipeline.environments,
    requestedEnvironment,
  );
  if (!environment) return null;
  const releases = (
    await sql.query<{
      external_id: string;
      to_sha: string | null;
      deployed_at: Date;
    }>(
      `SELECT external_id,to_sha,deployed_at FROM cloud_pipeline_releases WHERE organization_id=$1 AND pipeline_id=$2 AND environment=$3
      AND (external_id=$4 OR deployed_at=(SELECT max(deployed_at) FROM cloud_pipeline_releases WHERE organization_id=$1 AND pipeline_id=$2 AND environment=$3))`,
      [pipeline.organizationId, pipeline.id, environment, externalId],
    )
  ).rows;
  if (releases.some((release) => release.external_id === externalId))
    return null;
  const previous = releases[0];
  return {
    environment,
    last: environment === pipeline.environments.at(-1),
    fromSha: previous?.to_sha ?? null,
    since: previous?.deployed_at ?? pipeline.createdAt,
  };
}

async function teamKeys(sql: CloudSql, organizationId: string) {
  return (
    await sql.query<{ key: string }>(
      "SELECT key FROM cloud_teams WHERE organization_id=$1",
      [organizationId],
    )
  ).rows.map((row) => row.key);
}

async function insertRelease(
  sql: CloudSql,
  pipeline: PipelineTarget,
  window: ReleaseWindow,
  deployed: DeployedVersion,
  links: ReleaseLinks,
): Promise<string | null> {
  const id = (
    await sql.query<{ id: string }>(
      `INSERT INTO cloud_pipeline_releases (organization_id,id,pipeline_id,environment,version,external_id,from_sha,to_sha,evidence_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (organization_id,pipeline_id,environment,external_id) DO NOTHING RETURNING id`,
      [
        pipeline.organizationId,
        randomUUID(),
        pipeline.id,
        window.environment,
        deployed.version,
        deployed.externalId,
        window.fromSha,
        deployed.sha,
        deployed.url,
      ],
    )
  ).rows[0]?.id;
  if (!id) return null;
  await sql.query(
    `INSERT INTO cloud_pipeline_release_pull_requests (organization_id,release_id,pull_request_id)
    SELECT organization_id,$2,id FROM cloud_git_pull_requests WHERE organization_id=$1 AND id=ANY($3::uuid[])`,
    [pipeline.organizationId, id, links.pullRequestIds],
  );
  await sql.query(
    `INSERT INTO cloud_pipeline_release_issues (organization_id,release_id,issue_id,source)
    SELECT DISTINCT organization_id,$2::uuid,issue_id,'automatic' FROM cloud_git_pull_request_issues WHERE organization_id=$1 AND pull_request_id=ANY($3::uuid[])
    ON CONFLICT DO NOTHING`,
    [pipeline.organizationId, id, links.pullRequestIds],
  );
  const keys = await teamKeys(sql, pipeline.organizationId);
  const identifiers = [
    ...new Set(
      links.messages.flatMap((message) =>
        pullRequestReferences(
          { branch: "", title: message, body: "" },
          keys,
        ).map((reference) => reference.identifier),
      ),
    ),
  ];
  await sql.query(
    `INSERT INTO cloud_pipeline_release_issues (organization_id,release_id,issue_id,source)
    SELECT organization_id,$2,id,'automatic' FROM cloud_issues WHERE organization_id=$1 AND identifier=ANY($3::text[])
    ON CONFLICT DO NOTHING`,
    [pipeline.organizationId, id, identifiers],
  );
  await queueAutomationEvents(sql, {
    organizationId: pipeline.organizationId,
    teamId: null,
    issueId: null,
    actorId: null,
    events: [
      {
        kind: "release_event",
        pipelineId: pipeline.id,
        releaseId: id,
        environment: window.environment,
        version: deployed.version,
      },
    ],
  });
  return id;
}

export class CloudPipelineDeployments {
  constructor(
    private readonly database: CloudDatabase,
    private readonly issueChanges: CloudIssueChanges,
  ) {}

  private query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[],
  ) {
    return this.database.transaction((sql) => sql.query<T>(text, values));
  }

  async ingest(
    organizationId: string,
    repository: StoredRepository,
    deployment: DeploymentEvent,
    client: GitClient,
  ): Promise<void> {
    const pipelines = (
      await this.query<PipelineTarget & Record<string, unknown>>(
        `SELECT ${pipelineColumns} FROM cloud_release_pipelines p WHERE p.organization_id=$1 AND p.repository_id=$2 AND p.source=$3 AND NOT p.archived ORDER BY p.created_at,p.id`,
        [organizationId, repository.id, deployment.source],
      )
    ).rows;
    const files = new Map<number, Promise<string[]>>();
    const changedFiles = (number: number) => {
      const cached =
        files.get(number) ??
        client
          .files(repository.fullName, number)
          .then((entries) => entries.map((entry) => entry.filename));
      files.set(number, cached);
      return cached;
    };
    for (const pipeline of pipelines) {
      const window = await this.database.transaction((sql) =>
        releaseWindow(
          sql,
          pipeline,
          deployment.environment,
          deployment.externalId,
        ),
      );
      if (!window) continue;
      const merged = (
        await this.query<{ id: string; number: number }>(
          `SELECT p.id,p.number FROM cloud_git_pull_requests p WHERE p.organization_id=$1 AND p.repository_id=$2 AND p.state='merged' AND p.merged_at>$3
          AND NOT EXISTS (SELECT 1 FROM cloud_pipeline_release_pull_requests rp JOIN cloud_pipeline_releases r ON r.organization_id=rp.organization_id AND r.id=rp.release_id
            WHERE rp.organization_id=$1 AND rp.pull_request_id=p.id AND r.pipeline_id=$4 AND r.environment=$5)
          ORDER BY p.number`,
          [
            organizationId,
            repository.id,
            window.since,
            pipeline.id,
            window.environment,
          ],
        )
      ).rows;
      const pullRequestIds: string[] = [];
      for (const pullRequest of merged)
        if (
          touchesPaths(pipeline.paths, await changedFiles(pullRequest.number))
        )
          pullRequestIds.push(pullRequest.id);
      const comparison =
        window.fromSha && window.fromSha !== deployment.sha
          ? await client.compare(
              repository.fullName,
              window.fromSha,
              deployment.sha,
            )
          : null;
      const messages =
        comparison && touchesPaths(pipeline.paths, comparison.files)
          ? comparison.commits.map((commit) => commit.message)
          : [];
      await this.record(pipeline, window, deployment, {
        pullRequestIds,
        messages,
      });
    }
  }

  async ingestWebhook(
    webhookHash: string,
    deployment: PipelineDeployment,
  ): Promise<{ releaseId: string | null }> {
    const pipeline = (
      await this.query<PipelineTarget & Record<string, unknown>>(
        `SELECT ${pipelineColumns} FROM cloud_release_pipelines p WHERE p.webhook_hash=$1 AND p.source='webhook' AND NOT p.archived`,
        [webhookHash],
      )
    ).rows[0];
    if (!pipeline)
      throw new CloudError(404, "not_found", "This webhook is unavailable.");
    const externalId = deployment.externalId ?? deployment.version;
    const window = await this.database.transaction((sql) =>
      releaseWindow(sql, pipeline, deployment.environment, externalId),
    );
    if (!window) {
      if (!resolveEnvironment(pipeline.environments, deployment.environment))
        throw new CloudError(
          422,
          "pipeline_environment",
          `Use one of: ${pipeline.environments.join(", ")}.`,
        );
      return { releaseId: null };
    }
    const commits = deployment.commits.filter((commit) =>
      pipeline.paths.length ? touchesPaths(pipeline.paths, commit.paths) : true,
    );
    const messages = commits.map((commit) => commit.message);
    const numbers = [
      ...new Set(
        messages.flatMap((message) =>
          [...message.matchAll(pullRequestNumberPattern)].map((match) =>
            Number(match[1]),
          ),
        ),
      ),
    ];
    const pullRequestIds = pipeline.repositoryId
      ? (
          await this.query<{ id: string }>(
            "SELECT id FROM cloud_git_pull_requests WHERE organization_id=$1 AND repository_id=$2 AND state='merged' AND number=ANY($3::integer[])",
            [pipeline.organizationId, pipeline.repositoryId, numbers],
          )
        ).rows.map((row) => row.id)
      : [];
    return {
      releaseId: await this.record(
        pipeline,
        window,
        { ...deployment, externalId },
        { pullRequestIds, messages },
      ),
    };
  }

  private async record(
    pipeline: PipelineTarget,
    window: ReleaseWindow,
    deployed: DeployedVersion,
    links: ReleaseLinks,
  ): Promise<string | null> {
    const releaseId = await this.database.transaction(async (sql) => {
      const id = await insertRelease(sql, pipeline, window, deployed, links);
      if (id)
        await recordEvent(
          sql,
          {
            organizationId: pipeline.organizationId,
            userId: pipeline.createdBy,
          },
          "release_pipeline.deployed",
          id,
          1,
          { pipelineId: pipeline.id, environment: window.environment },
        );
      return id;
    });
    if (releaseId && window.last)
      await this.completeReleased(pipeline, releaseId, deployed.version);
    return releaseId;
  }

  private async completeReleased(
    pipeline: PipelineTarget,
    releaseId: string,
    version: string,
  ): Promise<void> {
    const targets = (
      await this.query<{
        issueId: string;
        statusId: string;
        statusRevision: number;
      }>(
        `SELECT i.id AS "issueId",s.id AS "statusId",s.revision AS "statusRevision"
        FROM cloud_pipeline_release_issues ri
        JOIN cloud_issues i ON i.organization_id=ri.organization_id AND i.id=ri.issue_id
        JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id AND t.complete_issues_on_release
        JOIN LATERAL (SELECT id,revision FROM cloud_workflow_statuses w WHERE w.organization_id=i.organization_id AND w.team_id=i.team_id AND w.category='complete' AND NOT w.archived ORDER BY w.position LIMIT 1) s ON true
        WHERE ri.organization_id=$1 AND ri.release_id=$2 AND NOT ri.excluded AND NOT i.archived AND i.state NOT IN ('complete','canceled')
        ORDER BY i.identifier`,
        [pipeline.organizationId, releaseId],
      )
    ).rows;
    const actor: CloudActor = {
      organizationId: pipeline.organizationId,
      userId: pipeline.createdBy,
      automation: `${pipeline.name} ${version}`,
    };
    for (const target of targets) {
      try {
        await this.issueChanges.apply(
          actor,
          derivedCommandId(releaseId, `release-complete:${target.issueId}`),
          {
            issues: [{ id: target.issueId }],
            changes: {
              status: { id: target.statusId, revision: target.statusRevision },
            },
          },
        );
      } catch (error) {
        if (!isCloudError(error)) throw error;
        await this.database.transaction((sql) =>
          recordEvent(
            sql,
            actor,
            "release_pipeline.completion_failed",
            target.issueId,
            1,
            { releaseId, code: error.code },
          ),
        );
      }
    }
  }
}
