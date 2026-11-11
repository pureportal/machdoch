import type { CloudActor } from "../../../lib/cloud-contract";
import type { ChatContextEntity } from "../../../lib/cloud-chat-contract";
import { isCloudError, teamVisibility } from "../access";
import type { CloudSql } from "../database";
import { readIssue } from "../planning";

const maximumContextCharacters = 24_000;

export const agentSystemPrompt = `You are Agent, the assistant built into machdoch.cloud, a planning workspace for teams, issues, projects and cycles.

Work like a careful teammate:
- Look up current workspace data with the tools before answering questions about it. Use precise filters, and read an issue before describing it in detail.
- Never invent issues, people, dates or numbers. When the data does not contain the answer, say what is missing.
- When a request is ambiguous in a way that changes the answer, call ask_user with 2–6 short options instead of guessing.
- You cannot change data yourself. To create an issue, change an issue, post a comment, post a project update or settle an issue in triage, call the matching propose_* tool. The user confirms each proposal; mention proposals briefly in your answer.
- Issues in the triage status category are new requests waiting for review. To triage one, search for likely duplicates, suggest priority, assignee or labels with propose_issue_update when they are clear, and settle it with propose_triage.
- Lead with the answer. Be concise and use Markdown lists or tables when they help.
- Link issues as [IDENTIFIER](/cloud/issues/ID), projects as [Name](/cloud/projects/ID), initiatives as [Name](/cloud/initiatives/ID) and cycles as [Name](/cloud/cycles/ID), using the links from tool results and the context below.
- Reply in the language of the user's latest message.

The JSON user message contains the conversation; work on its latest user entry. Entries with role "tool" contain results of tools you called earlier in this turn.`;

function excerpt(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

async function issueSection(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<string> {
  let issue;
  try {
    issue = await readIssue(sql, actor, id);
  } catch (error) {
    if (isCloudError(error) && error.status === 404) return "";
    throw error;
  }
  const facts = (
    await sql.query<{
      assignee: string | null;
      project: string | null;
      cycle: string | null;
      labels: string[];
    }>(
      `SELECT u.name AS assignee,p.name AS project,c.name AS cycle,
        COALESCE((SELECT array_agg(l.name ORDER BY lower(l.name)) FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
          WHERE a.organization_id=i.organization_id AND a.issue_id=i.id),'{}') AS labels
      FROM cloud_issues i LEFT JOIN cloud_users u ON u.id=i.assignee_id
      LEFT JOIN cloud_projects p ON p.organization_id=i.organization_id AND p.id=i.project_id
      LEFT JOIN cloud_cycles c ON c.organization_id=i.organization_id AND c.id=i.cycle_id
      WHERE i.organization_id=$1 AND i.id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  const relations = (
    await sql.query<{ relation: string; link: string }>(
      `SELECT CASE
          WHEN r.kind='parent' AND r.source_id=$3 THEN 'Sub-issue'
          WHEN r.kind='parent' THEN 'Parent'
          WHEN r.kind='blocks' AND r.source_id=$3 THEN 'Blocks'
          WHEN r.kind='blocks' THEN 'Blocked by'
          ELSE 'Related' END AS relation,
        '['||o.identifier||'](/cloud/issues/'||o.id||') '||o.title||' ('||s.name||')' AS link
      FROM cloud_issue_relations r
      JOIN cloud_issues o ON o.organization_id=r.organization_id AND o.id=CASE WHEN r.source_id=$3 THEN r.target_id ELSE r.source_id END
      JOIN cloud_workflow_statuses s ON s.organization_id=o.organization_id AND s.id=o.status_id
      JOIN cloud_teams t ON t.organization_id=o.organization_id AND t.id=o.team_id
      JOIN cloud_memberships m ON m.organization_id=o.organization_id AND m.user_id=$2
      WHERE r.organization_id=$1 AND (r.source_id=$3 OR r.target_id=$3) AND r.removed_at IS NULL AND ${teamVisibility}
      ORDER BY relation,o.identifier LIMIT 40`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows;
  const comments = (
    await sql.query<{ author: string; body: string; created: string }>(
      `SELECT u.name AS author,c.body,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS created FROM cloud_comments c JOIN cloud_users u ON u.id=c.author_id
      WHERE c.organization_id=$1 AND c.issue_id=$2 AND NOT c.deleted ORDER BY c.created_at DESC,c.id DESC LIMIT 8`,
      [actor.organizationId, id],
    )
  ).rows.reverse();
  return [
    `## Issue [${issue.identifier}](/cloud/issues/${issue.id}): ${issue.title}`,
    `Status ${issue.statusName}; priority ${issue.priority}; assignee ${facts.assignee ?? "none"}; estimate ${issue.estimate ?? "none"}; project ${facts.project ?? "none"}; cycle ${facts.cycle ?? "none"}; due ${issue.dueOn ?? "none"}; labels ${facts.labels.join(", ") || "none"}.`,
    `Description:\n${excerpt(issue.description, 3000) || "None"}`,
    `Acceptance criteria:\n${excerpt(issue.acceptanceCriteria, 1500) || "None"}`,
    ...(relations.length
      ? [
          `Relations:\n${relations.map((entry) => `- ${entry.relation}: ${entry.link}`).join("\n")}`,
        ]
      : []),
    ...(comments.length
      ? [
          `Latest comments:\n${comments.map((comment) => `- ${comment.author} (${comment.created}): ${excerpt(comment.body, 400)}`).join("\n")}`,
        ]
      : []),
  ].join("\n");
}

async function projectSection(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<string> {
  const project = (
    await sql.query<{
      name: string;
      description: string;
      status: string;
      lead: string | null;
      startsOn: string | null;
      targetOn: string | null;
      total: number;
      completed: number;
      health: string | null;
      update: string | null;
    }>(
      `SELECT p.name,p.description,p.status,u.name AS lead,to_char(p.starts_on,'YYYY-MM-DD') AS "startsOn",to_char(p.target_on,'YYYY-MM-DD') AS "targetOn",
        (SELECT count(*)::integer FROM cloud_issues i WHERE i.organization_id=p.organization_id AND i.project_id=p.id AND NOT i.archived AND i.state<>'canceled') AS total,
        (SELECT count(*)::integer FROM cloud_issues i WHERE i.organization_id=p.organization_id AND i.project_id=p.id AND NOT i.archived AND i.state='complete') AS completed,
        (SELECT health FROM cloud_project_updates x WHERE x.organization_id=p.organization_id AND x.project_id=p.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) AS health,
        (SELECT body FROM cloud_project_updates x WHERE x.organization_id=p.organization_id AND x.project_id=p.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) AS update
      FROM cloud_projects p JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
      JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
      LEFT JOIN cloud_users u ON u.id=p.lead_id
      WHERE p.organization_id=$1 AND p.id=$3 AND ${teamVisibility}`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!project) return "";
  return [
    `## Project [${project.name}](/cloud/projects/${id})`,
    `Status ${project.status}; health ${project.health ?? "not reported"}; lead ${project.lead ?? "none"}; ${project.startsOn ?? "no start"} to ${project.targetOn ?? "no target"}; ${project.completed}/${project.total} issues completed.`,
    `Description:\n${excerpt(project.description, 1500) || "None"}`,
    ...(project.update
      ? [`Latest update:\n${excerpt(project.update, 800)}`]
      : []),
  ].join("\n");
}

async function cycleSection(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<string> {
  const cycle = (
    await sql.query<{
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
      `SELECT c.name,t.key AS team,c.status,to_char(c.starts_on,'YYYY-MM-DD') AS "startsOn",to_char(c.ends_on,'YYYY-MM-DD') AS "endsOn",c.capacity,
        count(i.id)::integer AS total,count(i.id) FILTER (WHERE i.state='complete')::integer AS done,
        COALESCE(sum(i.estimate_points),0)::double precision AS points,COALESCE(sum(i.estimate_points) FILTER (WHERE i.state='complete'),0)::double precision AS "donePoints"
      FROM cloud_cycles c JOIN cloud_teams t ON t.organization_id=c.organization_id AND t.id=c.team_id
      JOIN cloud_memberships m ON m.organization_id=c.organization_id AND m.user_id=$2
      LEFT JOIN cloud_issues i ON i.organization_id=c.organization_id AND i.cycle_id=c.id AND NOT i.archived
      WHERE c.organization_id=$1 AND c.id=$3 AND ${teamVisibility}
      GROUP BY c.name,t.key,c.status,c.starts_on,c.ends_on,c.capacity`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!cycle) return "";
  return `## Cycle [${cycle.name}](/cloud/cycles/${id})\nTeam ${cycle.team}; ${cycle.status}; ${cycle.startsOn} to ${cycle.endsOn}; ${cycle.done}/${cycle.total} issues and ${cycle.donePoints}/${cycle.points} points complete${cycle.capacity !== null ? `; capacity ${cycle.capacity} points` : ""}.`;
}

async function teamSection(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<string> {
  const team = (
    await sql.query<{
      name: string;
      key: string;
      statuses: string[];
      open: number;
    }>(
      `SELECT t.name,t.key,
        (SELECT array_agg(s.name ORDER BY s.position) FROM cloud_workflow_statuses s WHERE s.organization_id=t.organization_id AND s.team_id=t.id AND NOT s.archived) AS statuses,
        (SELECT count(*)::integer FROM cloud_issues i WHERE i.organization_id=t.organization_id AND i.team_id=t.id AND NOT i.archived AND i.state NOT IN ('complete','canceled')) AS open
      FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
      WHERE t.organization_id=$1 AND t.id=$3 AND ${teamVisibility}`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!team) return "";
  return `## Team ${team.name} (${team.key})\n${team.open} open issues. Statuses: ${team.statuses.join(", ")}.`;
}

const sectionBuilders = {
  issue: issueSection,
  project: projectSection,
  cycle: cycleSection,
  team: teamSection,
};

export async function agentContext(
  sql: CloudSql,
  actor: CloudActor,
  context: ChatContextEntity[],
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
      targetOn: string | null;
    }>(
      `SELECT p.id,p.name,t.key AS team,p.status,to_char(p.target_on,'YYYY-MM-DD') AS "targetOn"
      FROM cloud_projects p JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
      JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
      WHERE p.organization_id=$1 AND ${teamVisibility} AND p.status NOT IN ('completed','canceled') ORDER BY p.name LIMIT 30`,
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
    }>(
      `SELECT c.id,c.name,t.key AS team,c.status,to_char(c.starts_on,'YYYY-MM-DD') AS "startsOn",to_char(c.ends_on,'YYYY-MM-DD') AS "endsOn"
      FROM cloud_cycles c JOIN cloud_teams t ON t.organization_id=c.organization_id AND t.id=c.team_id
      JOIN cloud_memberships m ON m.organization_id=c.organization_id AND m.user_id=$2
      WHERE c.organization_id=$1 AND ${teamVisibility} AND c.status<>'closed' ORDER BY c.starts_on LIMIT 8`,
      scope,
    )
  ).rows;
  const focus = [];
  for (const entry of context)
    focus.push(await sectionBuilders[entry.kind](sql, actor, entry.id));
  const sections = [
    `# Workspace\nOrganization: ${identity.organization}. User: ${identity.person}. Today: ${identity.today} (UTC).`,
    ...(focus.some(Boolean)
      ? [`# Context the user added\n${focus.filter(Boolean).join("\n\n")}`]
      : []),
    teams.length
      ? `## Teams\n${teams.map((team) => `- ${team.name} (${team.key})`).join("\n")}`
      : "## Teams\nNo accessible teams.",
    projects.length
      ? `## Open projects\n${projects.map((project) => `- [${project.name}](/cloud/projects/${project.id}) — ${project.team}, ${project.status}${project.targetOn ? `, target ${project.targetOn}` : ""}`).join("\n")}`
      : "",
    cycles.length
      ? `## Current and upcoming cycles\n${cycles.map((cycle) => `- [${cycle.name}](/cloud/cycles/${cycle.id}) — ${cycle.team}, ${cycle.status}, ${cycle.startsOn} to ${cycle.endsOn}`).join("\n")}`
      : "",
  ].filter(Boolean);
  let result = "";
  for (const part of sections) {
    if (result.length + part.length + 2 > maximumContextCharacters) break;
    result += `${result ? "\n\n" : ""}${part}`;
  }
  return result;
}
