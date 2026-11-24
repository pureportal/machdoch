import type { ChatContextKind } from "../../../lib/cloud-chat-contract";
import { teamVisibility } from "../access";
import { savedViewVisible } from "../saved-views";

interface ContextScope {
  organization: string;
  user: string;
  id: string;
}

function teamEntity(
  table: string,
  label: string,
  title: string,
  teamColumn: string,
  scope: ContextScope,
): string {
  return `SELECT ${label} AS label,${title} AS title FROM ${table} e
    JOIN cloud_teams t ON t.organization_id=e.organization_id AND t.id=${teamColumn}
    JOIN cloud_memberships m ON m.organization_id=e.organization_id AND m.user_id=${scope.user}
    WHERE e.organization_id=${scope.organization} AND e.id=${scope.id} AND ${teamVisibility}`;
}

const contextSources: Record<ChatContextKind, (scope: ContextScope) => string> =
  {
    issue: (scope) =>
      teamEntity("cloud_issues", "e.identifier", "e.title", "e.team_id", scope),
    project: (scope) =>
      teamEntity("cloud_projects", "e.name", "NULL::text", "e.team_id", scope),
    cycle: (scope) =>
      teamEntity("cloud_cycles", "e.name", "NULL::text", "e.team_id", scope),
    team: (scope) =>
      teamEntity("cloud_teams", "e.name", "NULL::text", "e.id", scope),
    document: (scope) =>
      teamEntity(
        "cloud_documents",
        "e.title",
        "NULL::text",
        "e.team_id",
        scope,
      ),
    loop: (
      scope,
    ) => `SELECT COALESCE(a.name,s.name) AS label,NULL::text AS title FROM cloud_loops l
    LEFT JOIN cloud_automations a ON a.organization_id=l.organization_id AND a.id=l.automation_id
    LEFT JOIN cloud_schedules s ON s.organization_id=l.organization_id AND s.id=l.schedule_id
    JOIN cloud_teams t ON t.organization_id=l.organization_id AND t.id=COALESCE(a.team_id,s.team_id)
    JOIN cloud_memberships m ON m.organization_id=l.organization_id AND m.user_id=${scope.user}
    WHERE l.organization_id=${scope.organization} AND l.id=${scope.id} AND ${teamVisibility} AND (s.id IS NULL OR NOT s.archived)`,
    view: (
      scope,
    ) => `SELECT v.name AS label,NULL::text AS title FROM cloud_saved_views v
    WHERE v.organization_id=${scope.organization} AND v.id=${scope.id} AND ${savedViewVisible("v", scope.user)}`,
    release: (
      scope,
    ) => `SELECT (p.definition->>'name')||' '||r.version AS label,r.name AS title FROM cloud_releases r
    JOIN cloud_products p ON p.organization_id=r.organization_id AND p.id=r.product_id
    WHERE r.organization_id=${scope.organization} AND r.id=${scope.id} AND cloud_member_can(r.organization_id,${scope.user},'releases.view')
    UNION ALL SELECT p.name||' '||r.version,r.environment FROM cloud_pipeline_releases r
    JOIN cloud_release_pipelines p ON p.organization_id=r.organization_id AND p.id=r.pipeline_id
    WHERE r.organization_id=${scope.organization} AND r.id=${scope.id} AND cloud_member_can(r.organization_id,${scope.user},'releases.view')`,
    pull_request: (
      scope,
    ) => `SELECT r.full_name||'#'||p.number AS label,p.title FROM cloud_git_pull_requests p
    JOIN cloud_git_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
    WHERE p.organization_id=${scope.organization} AND p.id=${scope.id} AND cloud_member_can(p.organization_id,${scope.user},'git.view')`,
    repository: (
      scope,
    ) => `SELECT r.full_name AS label,NULL::text AS title FROM cloud_git_repositories r
    WHERE r.organization_id=${scope.organization} AND r.id=${scope.id} AND cloud_member_can(r.organization_id,${scope.user},'git.view')`,
  };

export function chatContextSource(
  kind: ChatContextKind,
  scope: ContextScope,
): string {
  return contextSources[kind](scope);
}

export const chatContextColumn = `COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',x.kind,'id',x.entity_id,'label',e.label,'title',e.title,'turnSequence',x.turn_sequence) ORDER BY x.created_at,x.kind,x.entity_id)
  FROM cloud_chat_context x
  JOIN LATERAL (${Object.keys(contextSources)
    .map(
      (kind) =>
        `SELECT * FROM (${chatContextSource(kind as ChatContextKind, { organization: "x.organization_id", user: "$2", id: "x.entity_id" })}) k WHERE x.kind='${kind}'`,
    )
    .join(" UNION ALL ")}) e ON true
  WHERE x.organization_id=ch.organization_id AND x.chat_id=ch.id),'[]'::jsonb)`;
