import { automationMarker } from "../../../lib/git-events";
import type { SettingsCipher } from "../../settings-crypto";
import { isCloudError } from "../access";
import type { CloudDatabase } from "../database";
import { gitConnection, type GitConnectionRecord } from "./connections";
import { gitClient } from "./git-client";

const retryDelay = "5 minutes";
const maximumDescriptionCharacters = 4000;

const linkedIssues = `SELECT i.identifier,i.title,i.description FROM cloud_git_pull_request_issues l
JOIN cloud_issues i ON i.organization_id=l.organization_id AND i.id=l.issue_id
JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
WHERE l.organization_id=p.organization_id AND l.pull_request_id=p.id AND t.visibility='organization'`;

const linkedRuns = `SELECT r.id,r.title,r.created_at FROM cloud_run_deliveries d
JOIN cloud_runs r ON r.organization_id=d.organization_id AND r.id=d.run_id
WHERE d.organization_id=p.organization_id AND d.pull_request_id=p.id`;

const descriptions = "COALESCE(st.backlink_descriptions,false)";

const sourceDigest = `md5(concat_ws(E'\\n',$1::text,${descriptions}::text,
(SELECT string_agg(concat_ws(' ',x.identifier,x.title,CASE WHEN ${descriptions} THEN x.description END),E'\\n' ORDER BY x.identifier) FROM (${linkedIssues}) x),
(SELECT string_agg(x.id::text||' '||x.title,E'\\n' ORDER BY x.created_at,x.id) FROM (${linkedRuns}) x)))`;

interface LinkedIssue {
  identifier: string;
  title: string;
  description: string;
}

interface LinkedRun {
  id: string;
  title: string;
}

interface Backlink {
  organizationId: string;
  pullRequestId: string;
  connectionId: string;
  fullName: string;
  number: number;
  descriptions: boolean;
  digest: string;
  issues: LinkedIssue[];
  runs: LinkedRun[];
}

function linkText(text: string): string {
  return text.replace(/[\\[\]]/gu, "\\$&");
}

function issueSection(
  origin: string,
  issue: LinkedIssue,
  descriptions: boolean,
): string {
  const link = `[${linkText(`${issue.identifier} ${issue.title}`)}](${origin}/cloud/issues/${issue.identifier})`;
  const description = issue.description.trim();
  if (!descriptions || !description) return link;
  const shown =
    description.length > maximumDescriptionCharacters
      ? `${description.slice(0, maximumDescriptionCharacters)}…`
      : description;
  return `${link}\n\n<details><summary>Description</summary>\n\n${shown}\n\n</details>`;
}

function backlinkBody(origin: string, backlink: Backlink): string {
  const links = [
    `[Review in machdoch](${origin}/cloud/pull-requests/${backlink.pullRequestId})`,
    ...backlink.runs.map(
      (run) =>
        `[Agent session: ${linkText(run.title)}](${origin}/cloud/tasks/${run.id})`,
    ),
  ];
  return [
    ...backlink.issues.map((issue) =>
      issueSection(origin, issue, backlink.descriptions),
    ),
    links.join(" · "),
    automationMarker,
  ].join("\n\n");
}

export class CloudGitBacklinks {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
    private readonly transport: typeof fetch,
  ) {}

  async tick(): Promise<number> {
    if (!this.cipher || !this.origin) return 0;
    const claimed = await this.database.transaction(async (sql) => {
      const backlink = (
        await sql.query<Backlink & Record<string, unknown>>(
          `SELECT p.organization_id AS "organizationId",p.id AS "pullRequestId",r.connection_id AS "connectionId",r.full_name AS "fullName",p.number,
          ${descriptions} AS descriptions,${sourceDigest} AS digest,
          COALESCE((SELECT json_agg(x ORDER BY x.identifier) FROM (${linkedIssues}) x),'[]') AS issues,
          COALESCE((SELECT json_agg(x ORDER BY x.created_at,x.id) FROM (${linkedRuns}) x),'[]') AS runs
          FROM cloud_git_pull_requests p
          JOIN cloud_git_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
          LEFT JOIN cloud_git_settings st ON st.organization_id=p.organization_id
          LEFT JOIN cloud_git_backlinks b ON b.organization_id=p.organization_id AND b.pull_request_id=p.id
          WHERE p.state='open'
          AND CASE WHEN r.private THEN COALESCE(st.backlinks_private,true) ELSE COALESCE(st.backlinks_public,false) END
          AND (EXISTS (${linkedIssues}) OR EXISTS (${linkedRuns}))
          AND (b.attempted_at IS NULL OR b.attempted_at<clock_timestamp()-interval '${retryDelay}')
          AND b.digest IS DISTINCT FROM ${sourceDigest}
          ORDER BY b.attempted_at NULLS FIRST,p.updated_at,p.id LIMIT 1`,
          [this.origin],
        )
      ).rows[0];
      if (!backlink) return null;
      const claim = (
        await sql.query<{ external_id: string | null }>(
          `INSERT INTO cloud_git_backlinks (organization_id,pull_request_id,attempted_at) VALUES ($1,$2,clock_timestamp())
          ON CONFLICT (organization_id,pull_request_id) DO UPDATE SET attempted_at=clock_timestamp()
          WHERE cloud_git_backlinks.attempted_at IS NULL OR cloud_git_backlinks.attempted_at<clock_timestamp()-interval '${retryDelay}'
          RETURNING external_id`,
          [backlink.organizationId, backlink.pullRequestId],
        )
      ).rows[0];
      if (!claim) return null;
      return {
        backlink,
        externalId: claim.external_id,
        connection: await gitConnection(
          sql,
          this.cipher,
          backlink.organizationId,
          backlink.connectionId,
        ),
      };
    });
    if (!claimed) return 0;
    const { backlink } = claimed;
    let externalId: string | null = null;
    let failure: unknown = null;
    try {
      externalId = await this.publish(
        claimed.connection,
        backlink,
        claimed.externalId,
      );
    } catch (error) {
      failure = error;
    }
    await this.database.transaction((sql) =>
      externalId
        ? sql.query(
            `UPDATE cloud_git_backlinks SET external_id=$3,digest=$4,attempted_at=NULL,last_error=NULL
            WHERE organization_id=$1 AND pull_request_id=$2`,
            [
              backlink.organizationId,
              backlink.pullRequestId,
              externalId,
              backlink.digest,
            ],
          )
        : sql.query(
            "UPDATE cloud_git_backlinks SET last_error=$3 WHERE organization_id=$1 AND pull_request_id=$2",
            [
              backlink.organizationId,
              backlink.pullRequestId,
              (failure instanceof Error
                ? failure.message
                : String(failure)
              ).slice(0, 500),
            ],
          ),
    );
    if (failure && !isCloudError(failure)) throw failure;
    return 1;
  }

  private async publish(
    connection: GitConnectionRecord,
    backlink: Backlink,
    externalId: string | null,
  ): Promise<string> {
    const client = gitClient(connection, this.transport);
    const body = backlinkBody(this.origin, backlink);
    if (externalId)
      try {
        await client.editPullRequestComment(
          backlink.fullName,
          backlink.number,
          externalId,
          body,
        );
        return externalId;
      } catch (error) {
        if (!isCloudError(error) || error.status !== 404) throw error;
      }
    return client.postPullRequestComment(
      backlink.fullName,
      backlink.number,
      body,
    );
  }
}
