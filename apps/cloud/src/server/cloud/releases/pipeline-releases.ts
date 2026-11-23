import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  PipelineReleaseDetail,
  PipelineReleaseIssue,
} from "../../../lib/cloud-release-pipeline-contract";
import { releaseInputSchema } from "../../../lib/cloud-release-contract";
import { releaseNotes } from "../../../lib/release-notes";
import {
  CloudError,
  recordEvent,
  requireMembership,
  teamVisibility,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { pipelineTimestamp, visiblePipeline } from "./pipelines";
import type { CloudReleases } from "./releases";

type ReleaseHeader = Omit<PipelineReleaseDetail, "issues" | "notes">;

const visibleIssue = `JOIN cloud_issues i ON i.organization_id=ri.organization_id AND i.id=ri.issue_id
  JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
  JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2`;

async function readHeader(
  sql: CloudSql,
  actor: CloudActor,
  releaseId: string,
): Promise<ReleaseHeader> {
  const row = (
    await sql.query<ReleaseHeader & Record<string, unknown>>(
      `SELECT x.id,x.version,x.environment,${pipelineTimestamp("x.deployed_at")} AS "deployedAt",x.from_sha AS "fromSha",x.to_sha AS "toSha",
      x.evidence_url AS "evidenceUrl",p.id AS "pipelineId",p.name AS "pipelineName",0 AS "issueCount"
      FROM cloud_pipeline_releases x JOIN cloud_release_pipelines p ON p.organization_id=x.organization_id AND p.id=x.pipeline_id
      WHERE x.organization_id=$1 AND x.id=$3 AND ${visiblePipeline}`,
      [actor.organizationId, actor.userId, releaseId],
    )
  ).rows[0];
  if (!row) throw new CloudError(404, "not_found", "Release is unavailable.");
  return row;
}

async function readIssues(
  sql: CloudSql,
  actor: CloudActor,
  releaseId: string,
): Promise<(PipelineReleaseIssue & { team: string })[]> {
  return (
    await sql.query<
      PipelineReleaseIssue & { team: string } & Record<string, unknown>
    >(
      `SELECT i.id AS "issueId",i.identifier,i.title,i.state,ri.source,t.name AS team,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('number',g.number,'url',g.url,'title',g.title) ORDER BY g.number)
        FROM cloud_pipeline_release_pull_requests rp JOIN cloud_git_pull_requests g ON g.organization_id=rp.organization_id AND g.id=rp.pull_request_id
        JOIN cloud_git_pull_request_issues gl ON gl.organization_id=g.organization_id AND gl.pull_request_id=g.id AND gl.issue_id=i.id
        WHERE rp.organization_id=ri.organization_id AND rp.release_id=ri.release_id),'[]'::jsonb) AS "pullRequests"
      FROM cloud_pipeline_release_issues ri ${visibleIssue}
      WHERE ri.organization_id=$1 AND ri.release_id=$3 AND NOT ri.excluded AND ${teamVisibility}
      ORDER BY i.identifier`,
      [actor.organizationId, actor.userId, releaseId],
    )
  ).rows;
}

async function requireVisibleIssue(
  sql: CloudSql,
  actor: CloudActor,
  issueId: string,
): Promise<void> {
  const issue = await sql.query(
    `SELECT 1 FROM cloud_issues i JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
    JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
    WHERE i.organization_id=$1 AND i.id=$3 AND ${teamVisibility}`,
    [actor.organizationId, actor.userId, issueId],
  );
  if (!issue.rows.length)
    throw new CloudError(404, "not_found", "Issue is unavailable.");
}

export class CloudPipelineReleases {
  constructor(
    private readonly database: CloudDatabase,
    private readonly releases: CloudReleases,
  ) {}

  get(actor: CloudActor, releaseId: string): Promise<PipelineReleaseDetail> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.view");
      const header = await readHeader(sql, actor, releaseId);
      const rows = await readIssues(sql, actor, releaseId);
      const issues = rows.map(({ team: _team, ...issue }) => issue);
      return {
        ...header,
        issueCount: issues.length,
        issues,
        notes: releaseNotes(
          `${header.pipelineName} ${header.version}`,
          rows.map((issue) => ({
            identifier: issue.identifier,
            title: issue.title,
            team: issue.team,
            pullRequests: issue.pullRequests,
          })),
        ),
      };
    });
  }

  addIssue(
    actor: CloudActor,
    releaseId: string,
    issueId: string,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      await readHeader(sql, actor, releaseId);
      await requireVisibleIssue(sql, actor, issueId);
      await sql.query(
        `INSERT INTO cloud_pipeline_release_issues (organization_id,release_id,issue_id,source) VALUES ($1,$2,$3,'manual')
        ON CONFLICT (organization_id,release_id,issue_id) DO UPDATE SET excluded=false`,
        [actor.organizationId, releaseId, issueId],
      );
      await recordEvent(
        sql,
        actor,
        "pipeline_release.issue_added",
        releaseId,
        1,
        { issueId },
      );
    });
  }

  removeIssue(
    actor: CloudActor,
    releaseId: string,
    issueId: string,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "releases.edit");
      await readHeader(sql, actor, releaseId);
      await requireVisibleIssue(sql, actor, issueId);
      await sql.query(
        "DELETE FROM cloud_pipeline_release_issues WHERE organization_id=$1 AND release_id=$2 AND issue_id=$3 AND source='manual'",
        [actor.organizationId, releaseId, issueId],
      );
      await sql.query(
        "UPDATE cloud_pipeline_release_issues SET excluded=true WHERE organization_id=$1 AND release_id=$2 AND issue_id=$3 AND source='automatic'",
        [actor.organizationId, releaseId, issueId],
      );
      await recordEvent(
        sql,
        actor,
        "pipeline_release.issue_removed",
        releaseId,
        1,
        { issueId },
      );
    });
  }

  async createLaunch(
    actor: CloudActor,
    key: string,
    releaseId: string,
    productId: string,
  ): Promise<{ id: string }> {
    const release = await this.get(actor, releaseId);
    return this.releases.create(
      actor,
      key,
      releaseInputSchema.parse({
        productId,
        version: release.version,
        name: "",
        since: null,
        targetDate: null,
        issueIds: release.issues.map((issue) => issue.issueId),
      }),
    );
  }
}
