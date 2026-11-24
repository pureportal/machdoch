import type { CloudActor } from "../../../lib/cloud-contract";
import type { ChatContextKind } from "../../../lib/cloud-chat-contract";
import { issueFiltersFromParameters } from "../../../lib/issue-scopes";
import { teamVisibility } from "../access";
import type { CloudSql } from "../database";
import { issueFilterSql } from "../planning-queries";
import { chatContextSource } from "./chat-context-sources";

type SectionBuilder = (
  sql: CloudSql,
  actor: CloudActor,
  id: string,
) => Promise<string>;

export function excerpt(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

async function visibleLabel(
  sql: CloudSql,
  actor: CloudActor,
  kind: ChatContextKind,
  id: string,
): Promise<string | null> {
  const row = (
    await sql.query<{ label: string }>(
      chatContextSource(kind, { organization: "$1", user: "$2", id: "$3" }),
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  return row?.label ?? null;
}

async function linkedIssues(
  sql: CloudSql,
  actor: CloudActor,
  table: string,
  condition: string,
  id: string,
): Promise<string> {
  const lines = (
    await sql.query<{ line: string }>(
      `SELECT '- ['||i.identifier||'](/cloud/issues/'||i.id||') '||i.title||' ('||s.name||')' AS line FROM ${table} x
      JOIN cloud_issues i ON i.organization_id=x.organization_id AND i.id=x.issue_id
      JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
      JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
      JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
      WHERE x.organization_id=$1 AND ${condition} AND NOT i.archived AND ${teamVisibility}
      ORDER BY i.identifier LIMIT 40`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows;
  return lines.length
    ? `Issues:\n${lines.map((row) => row.line).join("\n")}`
    : "Issues: none";
}

const pullRequestSection: SectionBuilder = async (sql, actor, id) => {
  const label = await visibleLabel(sql, actor, "pull_request", id);
  if (!label) return "";
  const pullRequest = (
    await sql.query<{
      title: string;
      url: string;
      stage: string;
      author: string | null;
      headRef: string;
      baseRef: string;
      checks: string | null;
      review: string | null;
      reviewers: string[];
      additions: number;
      deletions: number;
      files: number;
    }>(
      `SELECT title,url,stage,author,head_ref AS "headRef",base_ref AS "baseRef",checks,review,requested_reviewers AS reviewers,
        additions,deletions,changed_files AS files FROM cloud_git_pull_requests WHERE organization_id=$1 AND id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  return [
    `## Pull request [${label}](/cloud/pull-requests/${id}): ${pullRequest.title}`,
    `Stage ${pullRequest.stage}; author ${pullRequest.author ?? "unknown"}; ${pullRequest.headRef} into ${pullRequest.baseRef}; checks ${pullRequest.checks ?? "none"}; review ${pullRequest.review ?? "none"}; requested reviewers ${pullRequest.reviewers.join(", ") || "none"}; +${pullRequest.additions} −${pullRequest.deletions} in ${pullRequest.files} files. ${pullRequest.url}`,
    await linkedIssues(
      sql,
      actor,
      "cloud_git_pull_request_issues",
      "x.pull_request_id=$3",
      id,
    ),
  ].join("\n");
};

const repositorySection: SectionBuilder = async (sql, actor, id) => {
  const label = await visibleLabel(sql, actor, "repository", id);
  if (!label) return "";
  const repository = (
    await sql.query<{
      provider: string;
      defaultBranch: string;
      private: boolean;
      url: string | null;
    }>(
      `SELECT provider,default_branch AS "defaultBranch",private,web_url AS url FROM cloud_git_repositories WHERE organization_id=$1 AND id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  const pullRequests = (
    await sql.query<{ line: string }>(
      `SELECT '- [#'||number||'](/cloud/pull-requests/'||id||') '||title||' ('||stage||')' AS line FROM cloud_git_pull_requests
      WHERE organization_id=$1 AND repository_id=$2 AND state='open' ORDER BY updated_at DESC LIMIT 30`,
      [actor.organizationId, id],
    )
  ).rows;
  return [
    `## Repository ${label}`,
    `${repository.provider}; default branch ${repository.defaultBranch}; ${repository.private ? "private" : "public"}.${repository.url ? ` ${repository.url}` : ""}`,
    pullRequests.length
      ? `Open pull requests:\n${pullRequests.map((row) => row.line).join("\n")}`
      : "Open pull requests: none",
  ].join("\n");
};

const viewSection: SectionBuilder = async (sql, actor, id) => {
  const view = (
    await sql.query<{
      name: string;
      description: string;
      scope: string;
      filters: Record<string, string>;
    }>(
      "SELECT v.name,v.description,v.scope,v.filters FROM cloud_saved_views v WHERE v.organization_id=$1 AND v.id=$2",
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!view || !(await visibleLabel(sql, actor, "view", id))) return "";
  const { where, parameters } = issueFilterSql(
    actor,
    issueFiltersFromParameters(view.filters),
  );
  const issues = (
    await sql.query<{ line: string; total: number }>(
      `SELECT '- ['||i.identifier||'](/cloud/issues/'||i.id||') '||i.title||' — '||s.name||', priority '||i.priority AS line,count(*) OVER ()::integer AS total
      FROM cloud_issues i
      JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
      JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
      JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
      WHERE ${where} AND ${teamVisibility} ORDER BY i.updated_at DESC,i.id LIMIT 30`,
      parameters,
    )
  ).rows;
  return [
    `## View [${view.name}](/cloud/views/${id})`,
    `Scope ${view.scope}. Filters: ${new URLSearchParams(view.filters).toString() || "none"}.`,
    ...(view.description
      ? [`Description: ${excerpt(view.description, 500)}`]
      : []),
    issues.length
      ? `Matching issues (${issues[0]!.total}):\n${issues.map((row) => row.line).join("\n")}`
      : "Matching issues: none",
  ].join("\n");
};

const releaseSection: SectionBuilder = async (sql, actor, id) => {
  const label = await visibleLabel(sql, actor, "release", id);
  if (!label) return "";
  const product = (
    await sql.query<{
      name: string;
      summary: string;
      notes: string;
      targetDate: string | null;
    }>(
      `SELECT name,summary,notes,to_char(target_date,'YYYY-MM-DD') AS "targetDate" FROM cloud_releases WHERE organization_id=$1 AND id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0];
  if (product)
    return [
      `## Release [${label}](/cloud/releases/${id})${product.name ? `: ${product.name}` : ""}`,
      `Target ${product.targetDate ?? "none"}.`,
      ...(product.summary ? [`Summary: ${excerpt(product.summary, 600)}`] : []),
      `Notes:\n${excerpt(product.notes, 2000) || "None"}`,
      await linkedIssues(
        sql,
        actor,
        "cloud_release_items",
        "x.release_id=$3 AND x.included",
        id,
      ),
    ].join("\n");
  const deployment = (
    await sql.query<{
      pipelineId: string;
      environment: string;
      deployedAt: string;
      pullRequests: number;
    }>(
      `SELECT r.pipeline_id AS "pipelineId",r.environment,to_char(r.deployed_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI') AS "deployedAt",
        (SELECT count(*)::integer FROM cloud_pipeline_release_pull_requests x WHERE x.organization_id=r.organization_id AND x.release_id=r.id) AS "pullRequests"
      FROM cloud_pipeline_releases r WHERE r.organization_id=$1 AND r.id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  return [
    `## Release [${label}](/cloud/releases/pipelines/${deployment.pipelineId}/${id})`,
    `Deployed to ${deployment.environment} at ${deployment.deployedAt} UTC; ${deployment.pullRequests} pull requests.`,
    await linkedIssues(
      sql,
      actor,
      "cloud_pipeline_release_issues",
      "x.release_id=$3 AND NOT x.excluded",
      id,
    ),
  ].join("\n");
};

const loopSection: SectionBuilder = async (sql, actor, id) => {
  const label = await visibleLabel(sql, actor, "loop", id);
  if (!label) return "";
  const loop = (
    await sql.query<{
      description: string;
      placement: string;
      harness: string;
      model: string;
      enabled: boolean;
    }>(
      `SELECT l.description,l.placement,l.harness,l.model,COALESCE(a.enabled,s.enabled) AS enabled FROM cloud_loops l
      LEFT JOIN cloud_automations a ON a.organization_id=l.organization_id AND a.id=l.automation_id
      LEFT JOIN cloud_schedules s ON s.organization_id=l.organization_id AND s.id=l.schedule_id
      WHERE l.organization_id=$1 AND l.id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  const runs = (
    await sql.query<{ line: string }>(
      `SELECT line FROM (
        SELECT '- '||to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')||' '||r.state||COALESCE(': '||r.error,'') AS line,r.created_at AS at
        FROM cloud_loops l JOIN cloud_automation_runs r ON r.organization_id=l.organization_id AND r.automation_id=l.automation_id
        WHERE l.organization_id=$1 AND l.id=$2
        UNION ALL SELECT '- '||to_char(to_timestamp(o.nominal_at/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')||' '||o.outcome||COALESCE(': '||o.reason,''),to_timestamp(o.nominal_at/1000.0)
        FROM cloud_loops l JOIN cloud_schedule_occurrences o ON o.organization_id=l.organization_id AND o.schedule_id=l.schedule_id
        WHERE l.organization_id=$1 AND l.id=$2) runs ORDER BY at DESC LIMIT 8`,
      [actor.organizationId, id],
    )
  ).rows;
  return [
    `## Loop [${label}](/cloud/loops/${id})`,
    `${loop.enabled ? "Enabled" : "Paused"}; runs on ${loop.placement} with ${loop.harness}${loop.model ? ` (${loop.model})` : ""}.`,
    ...(loop.description
      ? [`Description: ${excerpt(loop.description, 800)}`]
      : []),
    runs.length
      ? `Recent runs:\n${runs.map((row) => row.line).join("\n")}`
      : "Recent runs: none",
  ].join("\n");
};

const documentSection: SectionBuilder = async (sql, actor, id) => {
  const label = await visibleLabel(sql, actor, "document", id);
  if (!label) return "";
  const sections = (
    await sql.query<{ heading: string; body: string }>(
      "SELECT heading,body FROM cloud_document_sections WHERE organization_id=$1 AND document_id=$2 ORDER BY position DESC LIMIT 6",
      [actor.organizationId, id],
    )
  ).rows.reverse();
  return [
    `## Document [${label}](/cloud/documents/${id})`,
    ...(sections.length
      ? sections.map(
          (section) =>
            `### ${section.heading}\n${excerpt(section.body, 1200) || "Empty"}`,
        )
      : ["No sections yet."]),
  ].join("\n");
};

export const entitySectionBuilders = {
  pull_request: pullRequestSection,
  repository: repositorySection,
  view: viewSection,
  release: releaseSection,
  loop: loopSection,
  document: documentSection,
} satisfies Partial<Record<ChatContextKind, SectionBuilder>>;
