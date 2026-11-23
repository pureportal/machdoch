import type { CloudActor, IssueFilters } from "../../../lib/cloud-contract";
import type {
  LoopContextEntry,
  LoopContextKind,
  LoopContextSource,
} from "../../../lib/cloud-loop-contract";
import { issueFiltersFromParameters } from "../../../lib/issue-scopes";
import { teamVisibility } from "../access";
import type { CloudSql } from "../database";
import { issueFilterSql } from "../planning-queries";
import { savedViewVisible } from "../saved-views";

interface LoopRunInput {
  organizationId: string;
  id: string;
  automationId: string;
  payload: unknown;
}

const maximumItems = 50;
const maximumPayloadLength = 8_000;

export async function loopContextSources(
  sql: CloudSql,
  organizationId: string,
  loopId: string,
): Promise<LoopContextSource[]> {
  const rows = (
    await sql.query<{
      kind: LoopContextKind;
      savedViewId: string | null;
      filter: unknown;
      teamId: string | null;
      documentId: string | null;
      repositoryId: string | null;
      runCount: number | null;
    }>(
      `SELECT kind,saved_view_id AS "savedViewId",filter,team_id AS "teamId",document_id AS "documentId",repository_id AS "repositoryId",run_count AS "runCount"
      FROM cloud_loop_context_sources WHERE organization_id=$1 AND loop_id=$2 ORDER BY position`,
      [organizationId, loopId],
    )
  ).rows;
  return rows.map((row): LoopContextSource => {
    switch (row.kind) {
      case "saved_view":
        return { kind: row.kind, savedViewId: row.savedViewId! };
      case "filter":
        return {
          kind: row.kind,
          conditions: row.filter as Extract<
            LoopContextSource,
            { kind: "filter" }
          >["conditions"],
        };
      case "team_projects":
        return { kind: row.kind, teamId: row.teamId! };
      case "document":
        return { kind: row.kind, documentId: row.documentId! };
      case "repository":
        return { kind: row.kind, repositoryId: row.repositoryId! };
      case "trigger_payload":
        return { kind: row.kind };
      case "previous_runs":
        return { kind: row.kind, runCount: row.runCount! };
    }
  });
}

async function visibleIssues(
  sql: CloudSql,
  owner: CloudActor,
  filters: IssueFilters,
): Promise<string[]> {
  const { where, parameters } = issueFilterSql(owner, filters);
  return (
    await sql.query<{ line: string }>(
      `SELECT i.identifier||' · '||s.name||' · '||i.title AS line FROM cloud_issues i
      JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
      JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
      JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
      WHERE ${where} AND ${teamVisibility} ORDER BY i.updated_at DESC,i.id LIMIT ${maximumItems}`,
      parameters,
    )
  ).rows.map((row) => row.line);
}

async function resolveSource(
  sql: CloudSql,
  owner: CloudActor,
  run: LoopRunInput,
  source: LoopContextSource,
): Promise<LoopContextEntry> {
  const unavailable = (title: string) => ({
    kind: source.kind,
    title,
    items: [],
  });
  switch (source.kind) {
    case "saved_view": {
      const view = (
        await sql.query<{ name: string; filters: Record<string, string> }>(
          `SELECT v.name,v.filters FROM cloud_saved_views v WHERE v.organization_id=$1 AND v.id=$3 AND ${savedViewVisible("v", "$2")}`,
          [owner.organizationId, owner.userId, source.savedViewId],
        )
      ).rows[0];
      if (!view) return unavailable("Saved view unavailable");
      return {
        kind: source.kind,
        title: view.name,
        items: await visibleIssues(
          sql,
          owner,
          issueFiltersFromParameters(view.filters),
        ),
      };
    }
    case "filter":
      return {
        kind: source.kind,
        title: "Issues",
        items: await visibleIssues(sql, owner, {
          conditions: source.conditions,
        }),
      };
    case "team_projects": {
      const projects = (
        await sql.query<{ team: string; line: string }>(
          `SELECT t.name AS team,p.name||' · '||p.status||CASE WHEN p.description<>'' THEN ' · '||left(p.description,500) ELSE '' END AS line
          FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
          LEFT JOIN cloud_projects p ON p.organization_id=t.organization_id AND p.team_id=t.id AND p.status IN ('planned','active')
          WHERE t.organization_id=$1 AND t.id=$3 AND ${teamVisibility} ORDER BY lower(p.name),p.id LIMIT ${maximumItems}`,
          [owner.organizationId, owner.userId, source.teamId],
        )
      ).rows;
      if (!projects.length) return unavailable("Team unavailable");
      return {
        kind: source.kind,
        title: `${projects[0]!.team} projects`,
        items: projects.flatMap((project) =>
          project.line ? [project.line] : [],
        ),
      };
    }
    case "document": {
      const sections = (
        await sql.query<{ title: string; section: string | null }>(
          `SELECT d.title,ds.heading||E'\\n'||ds.body AS section FROM cloud_documents d
          JOIN cloud_teams t ON t.organization_id=d.organization_id AND t.id=d.team_id
          JOIN cloud_memberships m ON m.organization_id=d.organization_id AND m.user_id=$2
          LEFT JOIN cloud_document_sections ds ON ds.organization_id=d.organization_id AND ds.document_id=d.id
          WHERE d.organization_id=$1 AND d.id=$3 AND ${teamVisibility} ORDER BY ds.position DESC LIMIT 10`,
          [owner.organizationId, owner.userId, source.documentId],
        )
      ).rows;
      if (!sections.length) return unavailable("Document unavailable");
      return {
        kind: source.kind,
        title: sections[0]!.title,
        items: sections
          .flatMap((row) => (row.section ? [row.section.slice(0, 4_000)] : []))
          .reverse(),
      };
    }
    case "repository": {
      const repository = (
        await sql.query<{ fullName: string; allowed: boolean }>(
          `SELECT r.full_name AS "fullName",COALESCE(s.code_access,'all')='all' OR EXISTS (SELECT 1 FROM cloud_loop_code_repositories cr
            WHERE cr.organization_id=r.organization_id AND cr.repository_id=r.id) AS allowed
          FROM cloud_git_repositories r LEFT JOIN cloud_loop_settings s ON s.organization_id=r.organization_id
          WHERE r.organization_id=$1 AND r.id=$2`,
          [owner.organizationId, source.repositoryId],
        )
      ).rows[0];
      if (!repository?.allowed) return unavailable("Repository unavailable");
      const pullRequests = (
        await sql.query<{ line: string }>(
          `SELECT '#'||number||' · '||state||' · '||title AS line FROM cloud_git_pull_requests
          WHERE organization_id=$1 AND repository_id=$2 ORDER BY updated_at DESC,id LIMIT 20`,
          [owner.organizationId, source.repositoryId],
        )
      ).rows;
      return {
        kind: source.kind,
        title: repository.fullName,
        items: pullRequests.map((row) => row.line),
      };
    }
    case "trigger_payload":
      return {
        kind: source.kind,
        title: "Trigger",
        items: [JSON.stringify(run.payload).slice(0, maximumPayloadLength)],
      };
    case "previous_runs": {
      const runs = (
        await sql.query<{ line: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')||' · '||state||COALESCE(' · '||(
            SELECT string_agg(entry.value->>'detail',' · ') FROM jsonb_array_elements(steps) AS entry(value)),'') AS line
          FROM cloud_automation_runs WHERE organization_id=$1 AND automation_id=$2 AND id<>$3 AND NOT dry_run
          AND state IN ('succeeded','failed') ORDER BY created_at DESC,id LIMIT $4`,
          [run.organizationId, run.automationId, run.id, source.runCount],
        )
      ).rows;
      return {
        kind: source.kind,
        title: "Earlier runs",
        items: runs.map((row) => row.line.slice(0, 2_000)),
      };
    }
  }
}

export async function resolveLoopContext(
  sql: CloudSql,
  owner: CloudActor,
  run: LoopRunInput,
): Promise<LoopContextEntry[]> {
  const sources = await loopContextSources(
    sql,
    run.organizationId,
    run.automationId,
  );
  const entries: LoopContextEntry[] = [];
  for (const source of sources)
    entries.push(await resolveSource(sql, owner, run, source));
  return entries;
}

export function contextText(entries: LoopContextEntry[]): string {
  return entries
    .map((entry) =>
      [`## ${entry.title}`, ...entry.items.map((item) => `- ${item}`)].join(
        "\n",
      ),
    )
    .join("\n\n");
}
