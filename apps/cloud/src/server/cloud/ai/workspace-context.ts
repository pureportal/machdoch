import type { CloudActor } from "../../../lib/cloud-contract";
import { isCloudError, teamVisibility } from "../access";
import type { CloudSql } from "../database";
import { readIssue } from "../planning";

const maximumContextCharacters = 24_000;
const issueReferencePattern = /\b[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}\b/g;
const termPattern = /[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu;
const ignoredTerms = new Set(
  "about above after again also and any are because been before being below between both but can cannot could did does doing down during each few for from further had has have having her here hers him his how into its itself just let more most much must not now off once only other our ours out over own same she should some such than that the their theirs them then there these they this those through too under until very was were what when where which while who whom why will with would you your yours issue issues ticket tickets please show tell give list find which welche welcher welches eine einer eines einem einen der die das den dem des und oder aber nicht noch auch sind ist war waren wird werden wie was wer wann warum mit von bei für über unter zum zur aus auf alle mein meine meinen mir mich uns".split(
    " ",
  ),
);

interface ContextIssue extends Record<string, unknown> {
  id: string;
  identifier: string;
  title: string;
  description: string;
  statusName: string;
  state: string;
  priority: string;
  estimate: string | null;
  dueOn: string | null;
  updatedAt: string;
  assignee: string | null;
  project: string | null;
  cycle: string | null;
}

const issueSelection = `i.id,i.identifier,i.title,i.description,i.state,i.priority,i.estimate,to_char(i.due_on,'YYYY-MM-DD') AS "dueOn",
  to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "updatedAt",s.name AS "statusName",u.name AS assignee,p.name AS project,c.name AS cycle
  FROM cloud_issues i
  JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
  JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
  JOIN cloud_workflow_statuses s ON s.organization_id=i.organization_id AND s.id=i.status_id
  LEFT JOIN cloud_users u ON u.id=i.assignee_id
  LEFT JOIN cloud_projects p ON p.organization_id=i.organization_id AND p.id=i.project_id
  LEFT JOIN cloud_cycles c ON c.organization_id=i.organization_id AND c.id=i.cycle_id
  WHERE i.organization_id=$1 AND ${teamVisibility} AND NOT i.archived`;

function questionTerms(prompt: string): string[] {
  return [
    ...new Set(
      (prompt.toLowerCase().match(termPattern) ?? []).filter(
        (term) => !ignoredTerms.has(term) && !/^\d+$/.test(term),
      ),
    ),
  ].slice(0, 10);
}

function excerpt(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function issueLine(issue: ContextIssue): string {
  const facts = [
    issue.statusName,
    issue.priority !== "none" ? `${issue.priority} priority` : null,
    issue.assignee ? `assignee ${issue.assignee}` : "unassigned",
    issue.estimate ? `estimate ${issue.estimate}` : null,
    issue.project ? `project ${issue.project}` : null,
    issue.cycle ? `cycle ${issue.cycle}` : "no cycle",
    issue.dueOn ? `due ${issue.dueOn}` : null,
    `updated ${issue.updatedAt}`,
  ].filter(Boolean);
  const description = excerpt(issue.description, 220);
  return `- [${issue.identifier}](/cloud/issues/${issue.id}) ${issue.title} — ${facts.join(", ")}${description ? `\n  ${description}` : ""}`;
}

async function focusSection(
  sql: CloudSql,
  actor: CloudActor,
  issueId: string,
): Promise<string> {
  let issue;
  try {
    issue = await readIssue(sql, actor, issueId);
  } catch (error) {
    if (isCloudError(error) && error.status === 404) return "";
    throw error;
  }
  const comments = (
    await sql.query<{ author: string; body: string; created: string }>(
      `SELECT u.name AS author,c.body,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS created FROM cloud_comments c JOIN cloud_users u ON u.id=c.author_id
      WHERE c.organization_id=$1 AND c.issue_id=$2 AND NOT c.deleted ORDER BY c.created_at DESC,c.id DESC LIMIT 12`,
      [actor.organizationId, issueId],
    )
  ).rows.reverse();
  const runs = (
    await sql.query<{ state: string; summary: string | null; created: string }>(
      `SELECT state,summary,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS created FROM cloud_runs WHERE organization_id=$1 AND issue_id=$2 ORDER BY created_at DESC,id DESC LIMIT 3`,
      [actor.organizationId, issueId],
    )
  ).rows;
  return [
    `## Focused issue [${issue.identifier}](/cloud/issues/${issue.id})`,
    `Title: ${issue.title}`,
    `Status: ${issue.statusName}; priority ${issue.priority}; estimate ${issue.estimate ?? "none"}; due ${issue.dueOn ?? "none"}`,
    `Description:\n${excerpt(issue.description, 4000) || "None"}`,
    `Acceptance criteria:\n${excerpt(issue.acceptanceCriteria, 2000) || "None"}`,
    ...(comments.length
      ? [
          `Comments:\n${comments.map((comment) => `- ${comment.author} (${comment.created}): ${excerpt(comment.body, 600)}`).join("\n")}`,
        ]
      : []),
    ...(runs.length
      ? [
          `AI tasks:\n${runs.map((run) => `- ${run.state} (${run.created})${run.summary ? `: ${excerpt(run.summary, 400)}` : ""}`).join("\n")}`,
        ]
      : []),
  ].join("\n");
}

export async function workspaceContext(
  sql: CloudSql,
  actor: CloudActor,
  prompt: string,
  focusIssueId: string | null,
): Promise<string> {
  const scope = [actor.organizationId, actor.userId];
  const identity = (
    await sql.query<{ organization: string; person: string; today: string }>(
      "SELECT o.name AS organization,u.name AS person,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today FROM cloud_organizations o,cloud_users u WHERE o.id=$1 AND u.id=$2",
      scope,
    )
  ).rows[0]!;
  const teams = (
    await sql.query<{ key: string; name: string }>(
      `SELECT t.key,t.name FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
      WHERE t.organization_id=$1 AND ${teamVisibility} ORDER BY t.name LIMIT 30`,
      scope,
    )
  ).rows;
  const projects = (
    await sql.query<{
      id: string;
      name: string;
      team: string;
      status: string;
      lead: string | null;
      targetOn: string | null;
      open: number;
      done: number;
      description: string;
    }>(
      `SELECT p.id,p.name,t.key AS team,p.description,p.status,u.name AS lead,to_char(p.target_on,'YYYY-MM-DD') AS "targetOn",
        count(i.id) FILTER (WHERE i.state NOT IN ('complete','canceled'))::integer AS open,
        count(i.id) FILTER (WHERE i.state='complete')::integer AS done
      FROM cloud_projects p JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
      JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
      LEFT JOIN cloud_users u ON u.id=p.lead_id
      LEFT JOIN cloud_issues i ON i.organization_id=p.organization_id AND i.project_id=p.id AND NOT i.archived
      WHERE p.organization_id=$1 AND ${teamVisibility} GROUP BY p.id,p.name,t.key,p.description,p.status,u.name,p.target_on ORDER BY p.name LIMIT 30`,
      scope,
    )
  ).rows;
  const cycles = (
    await sql.query<{
      id: string;
      name: string;
      team: string;
      status: string;
      startsOn: string;
      endsOn: string;
      capacity: number | null;
      total: number;
      done: number;
      points: number;
      donePoints: number;
    }>(
      `SELECT c.id,c.name,t.key AS team,c.status,to_char(c.starts_on,'YYYY-MM-DD') AS "startsOn",to_char(c.ends_on,'YYYY-MM-DD') AS "endsOn",c.capacity,
        count(i.id)::integer AS total,count(i.id) FILTER (WHERE i.state='complete')::integer AS done,
        COALESCE(sum(i.estimate_points),0)::double precision AS points,COALESCE(sum(i.estimate_points) FILTER (WHERE i.state='complete'),0)::double precision AS "donePoints"
      FROM cloud_cycles c JOIN cloud_teams t ON t.organization_id=c.organization_id AND t.id=c.team_id
      JOIN cloud_memberships m ON m.organization_id=c.organization_id AND m.user_id=$2
      LEFT JOIN cloud_issues i ON i.organization_id=c.organization_id AND i.cycle_id=c.id AND NOT i.archived
      WHERE c.organization_id=$1 AND ${teamVisibility} AND c.status<>'closed'
      GROUP BY c.id,c.name,t.key,c.status,c.starts_on,c.ends_on,c.capacity ORDER BY c.starts_on LIMIT 8`,
      scope,
    )
  ).rows;
  const references = [
    ...new Set(
      (prompt.match(issueReferencePattern) ?? []).map((key) =>
        key.toUpperCase(),
      ),
    ),
  ].slice(0, 10);
  const terms = questionTerms(prompt);
  const referenced = references.length
    ? (
        await sql.query<ContextIssue>(
          `SELECT ${issueSelection} AND i.identifier=ANY($3::text[]) ORDER BY i.identifier`,
          [...scope, references],
        )
      ).rows
    : [];
  const matching = terms.length
    ? (
        await sql.query<ContextIssue>(
          `SELECT ${issueSelection} AND EXISTS (SELECT 1 FROM unnest($3::text[]) term WHERE strpos(lower(i.title||' '||i.identifier||' '||i.description),term)>0)
          ORDER BY (SELECT count(*) FROM unnest($3::text[]) term WHERE strpos(lower(i.title||' '||i.description),term)>0) DESC,i.updated_at DESC LIMIT 25`,
          [...scope, terms],
        )
      ).rows
    : [];
  const assigned = (
    await sql.query<ContextIssue>(
      `SELECT ${issueSelection} AND i.assignee_id=$2 AND i.state NOT IN ('complete','canceled')
      ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,i.updated_at DESC LIMIT 12`,
      scope,
    )
  ).rows;
  const recent = (
    await sql.query<ContextIssue>(
      `SELECT ${issueSelection} ORDER BY i.updated_at DESC LIMIT 12`,
      scope,
    )
  ).rows;
  const seen = new Set<string>();
  const section = (title: string, issues: ContextIssue[]) => {
    const unique = issues.filter((issue) => {
      if (seen.has(issue.id)) return false;
      seen.add(issue.id);
      return true;
    });
    return unique.length
      ? `## ${title}\n${unique.map(issueLine).join("\n")}`
      : "";
  };
  const sections = [
    `# Workspace snapshot\nOrganization: ${identity.organization}. User: ${identity.person}. Today: ${identity.today} (UTC).`,
    focusIssueId ? await focusSection(sql, actor, focusIssueId) : "",
    teams.length
      ? `## Teams\n${teams.map((team) => `- ${team.name} (${team.key})`).join("\n")}`
      : "",
    projects.length
      ? `## Projects\n${projects.map((project) => `- [${project.name}](/cloud/issues?projectId=${project.id}) — team ${project.team}, status ${project.status}${project.lead ? `, lead ${project.lead}` : ""}${project.targetOn ? `, target ${project.targetOn}` : ""}, ${project.open} open and ${project.done} completed issues${project.description ? `. ${excerpt(project.description, 160)}` : ""}`).join("\n")}`
      : "",
    cycles.length
      ? `## Current and upcoming cycles\n${cycles.map((cycle) => `- [${cycle.name}](/cloud/cycles/${cycle.id}) — team ${cycle.team}, ${cycle.status}, ${cycle.startsOn} to ${cycle.endsOn}, ${cycle.done}/${cycle.total} issues and ${cycle.donePoints}/${cycle.points} points complete${cycle.capacity !== null ? `, capacity ${cycle.capacity} points` : ""}`).join("\n")}`
      : "",
    section("Referenced issues", referenced),
    section("Issues matching the question", matching),
    section("Open issues assigned to the user", assigned),
    section("Recently updated issues", recent),
  ].filter(Boolean);
  let context = "";
  for (const part of sections) {
    if (context.length + part.length + 2 > maximumContextCharacters) break;
    context += `${context ? "\n\n" : ""}${part}`;
  }
  return context;
}
