import type { CloudOrganization } from "../../lib/cloud-administration-contract";
import { cycleColumns, issueColumns } from "./planning-queries";
import { randomUUID } from "node:crypto";
import { lockExecution } from "./execution/records";
import { readTeamWorkflows, resolveIssueStatus } from "./workflow-records";
import type {
  CloudActor,
  CloudCycle,
  CloudIssue,
  CloudMember,
  CloudProject,
  CloudTeam,
  CloudWorkspace,
  CycleInput,
  IssueInput,
  IssueUpdate,
  IssueSnapshot,
  TeamInput,
  EstimateCard,
} from "../../lib/cloud-contract";
import type { CloudDatabase, CloudSql } from "./database";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "./access";

export async function readIssue(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudIssue> {
  const identity = await sql.query<{ team_id: string }>(
    "SELECT team_id FROM cloud_issues WHERE organization_id=$1 AND id=$2",
    [actor.organizationId, id],
  );
  if (!identity.rows[0])
    throw new CloudError(404, "not_found", "Issue is unavailable.");
  await requireTeam(sql, actor, identity.rows[0].team_id, write);
  const result = await sql.query<CloudIssue & Record<string, unknown>>(
    `SELECT ${issueColumns} FROM cloud_issues i WHERE i.organization_id=$1 AND i.id=$2 FOR ${write ? "UPDATE" : "SHARE"} OF i`,
    [actor.organizationId, id],
  );
  return result.rows[0]!;
}

export async function recordIssue(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
): Promise<void> {
  await sql.query(
    "INSERT INTO cloud_issue_history (organization_id, issue_id, revision, actor_id, snapshot, status_name) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      actor.organizationId,
      issue.id,
      issue.revision,
      actor.userId,
      JSON.stringify(issue),
      issue.statusName,
    ],
  );
  await recordEvent(sql, actor, "issue.changed", issue.id, issue.revision, {
    state: issue.state,
    cycleId: issue.cycleId,
  });
}

export async function createIssueInTransaction(
  sql: CloudSql,
  actor: CloudActor,
  team: CloudTeam,
  input: IssueInput,
): Promise<{ id: string }> {
  const status = await resolveIssueStatus(sql, actor, team.id, input.status);
  const estimate = await validateIssueLinks(sql, actor, team, input);
  const sequence = (
    await sql.query<{ number: number }>(
      "UPDATE cloud_teams SET next_issue_number=next_issue_number+1 WHERE organization_id=$1 AND id=$2 RETURNING next_issue_number-1 AS number",
      [actor.organizationId, input.teamId],
    )
  ).rows[0]!.number;
  const id = randomUUID();
  await sql.query(
    `INSERT INTO cloud_issues (organization_id,id,team_id,identifier,title,description,acceptance_criteria,state,priority,project_id,cycle_id,assignee_id,estimate,estimate_points,estimate_scale_revision,due_on,status_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      actor.organizationId,
      id,
      input.teamId,
      `${team.key}-${sequence}`,
      input.title,
      input.description,
      input.acceptanceCriteria,
      status.category,
      input.priority,
      input.projectId,
      input.cycleId,
      input.assigneeId,
      input.estimate,
      estimate,
      team.scaleRevision,
      input.dueOn,
      status.id,
    ],
  );
  await recordIssue(sql, actor, await readIssue(sql, actor, id));
  return { id };
}

export class CloudPlanning {
  constructor(readonly database: CloudDatabase) {}

  workspace(actor: CloudActor): Promise<CloudWorkspace> {
    return this.database.transaction(async (sql) => {
      const role = await requireMembership(sql, actor);
      const organization = (
        await sql.query<CloudOrganization & Record<string, unknown>>(
          "SELECT id, name, accent, revision FROM cloud_organizations WHERE id=$1",
          [actor.organizationId],
        )
      ).rows[0]!;
      const members = (
        await sql.query<CloudMember & Record<string, unknown>>(
          `SELECT u.id, u.name, m.role FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.active AND NOT u.disabled ORDER BY u.name, u.id`,
          [actor.organizationId],
        )
      ).rows;
      const teams = (
        await sql.query<CloudTeam & Record<string, unknown>>(
          `SELECT t.id,t.name,t.key,t.visibility,t.estimate_scale AS "estimateScale",t.scale_revision AS "scaleRevision",t.revision
        FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2 WHERE t.organization_id=$1 AND ${teamVisibility} ORDER BY t.name,t.id FOR SHARE OF t`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
      const teamIds = teams.map((team) => team.id);
      const projects = (
        await sql.query<CloudProject & Record<string, unknown>>(
          `SELECT id,team_id AS "teamId",name,description,revision FROM cloud_projects WHERE organization_id=$1 AND team_id=ANY($2::uuid[]) ORDER BY name,id`,
          [actor.organizationId, teamIds],
        )
      ).rows;
      const cycles = (
        await sql.query<CloudCycle & Record<string, unknown>>(
          `SELECT ${cycleColumns} FROM cloud_cycles WHERE organization_id=$1 AND team_id=ANY($2::uuid[]) ORDER BY starts_on DESC,id`,
          [actor.organizationId, teamIds],
        )
      ).rows;
      return {
        organization,
        actor: {
          ...members.find((member) => member.id === actor.userId)!,
          role,
        },
        members,
        teams,
        projects,
        cycles,
        workflows: await readTeamWorkflows(sql, actor.organizationId, teamIds),
      };
    });
  }

  createTeam(
    actor: CloudActor,
    commandId: string,
    input: TeamInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      return command(
        sql,
        actor,
        commandId,
        { kind: "team.create", input },
        async () => {
          const id = randomUUID();
          await sql.query(
            `INSERT INTO cloud_teams (organization_id,id,name,key,visibility,estimate_scale) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              actor.organizationId,
              id,
              input.name,
              input.key,
              input.visibility,
              JSON.stringify(input.estimateScale),
            ],
          );
          await sql.query(
            "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
            [actor.organizationId, id, actor.userId],
          );
          await recordEvent(sql, actor, "team.created", id, 1, {});
          return { id };
        },
      );
    });
  }

  updateScale(
    actor: CloudActor,
    commandId: string,
    teamId: string,
    expectedRevision: number,
    scale: EstimateCard[],
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "admin");
      const team = await requireTeam(sql, actor, teamId, true);
      return command(
        sql,
        actor,
        commandId,
        { kind: "team.scale", teamId, expectedRevision, scale },
        async () => {
          checkRevision(team.revision, expectedRevision);
          await sql.query(
            "UPDATE cloud_teams SET estimate_scale=$3,scale_revision=scale_revision+1,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, teamId, JSON.stringify(scale)],
          );
          await recordEvent(
            sql,
            actor,
            "team.scale_changed",
            teamId,
            team.revision + 1,
            { scaleRevision: team.scaleRevision + 1 },
          );
          return { id: teamId };
        },
      );
    });
  }

  createCycle(
    actor: CloudActor,
    commandId: string,
    input: CycleInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, input.teamId, true);
      return command(
        sql,
        actor,
        commandId,
        { kind: "cycle.create", input },
        async () => {
          const overlap = await sql.query(
            "SELECT id FROM cloud_cycles WHERE organization_id=$1 AND team_id=$2 AND starts_on < $4::date AND ends_on > $3::date",
            [actor.organizationId, input.teamId, input.startsOn, input.endsOn],
          );
          if (overlap.rows.length)
            throw new CloudError(
              409,
              "cycle_overlap",
              "These dates overlap another cycle. Choose a different date range.",
            );
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_cycles (organization_id,id,team_id,name,starts_on,ends_on,timezone,capacity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              actor.organizationId,
              id,
              input.teamId,
              input.name,
              input.startsOn,
              input.endsOn,
              input.timezone,
              input.capacity,
            ],
          );
          await recordEvent(sql, actor, "cycle.created", id, 1, {});
          return { id };
        },
      );
    });
  }

  listIssues(
    actor: CloudActor,
    filters: {
      teamId?: string;
      projectId?: string;
      cycleId?: string;
      labelId?: string;
      statusId?: string;
      query?: string;
      archived?: boolean;
      offset?: number;
    } = {},
  ): Promise<CloudIssue[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudIssue & Record<string, unknown>>(
          `SELECT ${issueColumns} FROM cloud_issues i
        JOIN cloud_teams t ON t.organization_id=i.organization_id AND t.id=i.team_id
        JOIN cloud_memberships m ON m.organization_id=i.organization_id AND m.user_id=$2
        WHERE i.organization_id=$1 AND ${teamVisibility} AND i.archived=$3
        AND ($4::uuid IS NULL OR i.team_id=$4) AND ($5::uuid IS NULL OR i.project_id=$5) AND ($6::uuid IS NULL OR i.cycle_id=$6)
        AND ($7='' OR strpos(lower(i.title || ' ' || i.identifier || ' ' || i.description), lower($7))>0)
        AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM cloud_issue_labels a WHERE a.organization_id=i.organization_id AND a.issue_id=i.id AND a.label_id=$9))
        AND ($10::uuid IS NULL OR i.status_id=$10)
        ORDER BY i.updated_at DESC,i.id LIMIT 100 OFFSET $8`,
          [
            actor.organizationId,
            actor.userId,
            filters.archived ?? false,
            filters.teamId ?? null,
            filters.projectId ?? null,
            filters.cycleId ?? null,
            filters.query ?? "",
            filters.offset ?? 0,
            filters.labelId ?? null,
            filters.statusId ?? null,
          ],
        )
      ).rows;
    });
  }

  getIssue(actor: CloudActor, id: string): Promise<CloudIssue> {
    return this.database.transaction((sql) => readIssue(sql, actor, id));
  }

  createIssue(
    actor: CloudActor,
    commandId: string,
    input: IssueInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const team = await requireTeam(sql, actor, input.teamId, true);
      return command(
        sql,
        actor,
        commandId,
        { kind: "issue.create", input },
        () => createIssueInTransaction(sql, actor, team, input),
      );
    });
  }

  updateIssue(
    actor: CloudActor,
    commandId: string,
    id: string,
    input: IssueUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const issue = await readIssue(sql, actor, id, true);
      return command(
        sql,
        actor,
        commandId,
        { kind: "issue.update", id, input },
        async () => {
          checkRevision(issue.revision, input.revision);
          const status = await resolveIssueStatus(
            sql,
            actor,
            issue.teamId,
            input.status,
            issue.status.id,
          );
          const team = await requireTeam(sql, actor, issue.teamId, true);
          const points = await validateIssueLinks(
            sql,
            actor,
            team,
            { ...input, teamId: issue.teamId },
            issue,
          );
          const scaleChanged = issue.estimate !== input.estimate;
          await sql.query(
            `UPDATE cloud_issues SET title=$3,description=$4,acceptance_criteria=$5,state=$6,priority=$7,project_id=$8,cycle_id=$9,assignee_id=$10,
          estimate=$11,estimate_points=$12,estimate_scale_revision=CASE WHEN $13 THEN $14 ELSE estimate_scale_revision END,due_on=$15,archived=$16,status_id=$17,revision=revision+1,updated_at=clock_timestamp()
          WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              input.title,
              input.description,
              input.acceptanceCriteria,
              status.category,
              input.priority,
              input.projectId,
              input.cycleId,
              input.assigneeId,
              input.estimate,
              points,
              scaleChanged,
              team.scaleRevision,
              input.dueOn,
              input.archived,
              status.id,
            ],
          );
          await recordIssue(sql, actor, await readIssue(sql, actor, id));
          return { id };
        },
      );
    });
  }

  history(
    actor: CloudActor,
    id: string,
  ): Promise<
    {
      revision: number;
      actor: string;
      snapshot: IssueSnapshot;
      statusName: string;
      createdAt: string;
    }[]
  > {
    return this.database.transaction(async (sql) => {
      await readIssue(sql, actor, id);
      return (
        await sql.query<{
          revision: number;
          actor: string;
          snapshot: IssueSnapshot;
          statusName: string;
          createdAt: string;
        }>(
          `SELECT h.revision,u.name AS actor,h.snapshot,h.status_name AS "statusName",to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
        FROM cloud_issue_history h JOIN cloud_users u ON u.id=h.actor_id WHERE h.organization_id=$1 AND h.issue_id=$2 ORDER BY h.revision DESC LIMIT 100`,
          [actor.organizationId, id],
        )
      ).rows;
    });
  }
}

export async function validateIssueLinks(
  sql: CloudSql,
  actor: CloudActor,
  team: CloudTeam,
  input: IssueInput,
  previous?: CloudIssue,
): Promise<number | null> {
  for (const [table, id, label] of [
    ["cloud_projects", input.projectId, "Project"],
    ["cloud_cycles", input.cycleId, "Cycle"],
  ] as const) {
    if (
      id &&
      !(
        await sql.query(
          `SELECT id FROM ${table} WHERE organization_id=$1 AND team_id=$2 AND id=$3`,
          [actor.organizationId, team.id, id],
        )
      ).rows.length
    )
      throw new CloudError(
        422,
        "invalid_reference",
        `${label} is unavailable for this team.`,
      );
  }
  if (input.assigneeId) {
    const member = await sql.query(
      `SELECT m.user_id FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled
      AND ($3='organization' OR m.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM cloud_team_memberships tm WHERE tm.organization_id=m.organization_id AND tm.user_id=m.user_id AND tm.team_id=$4))`,
      [actor.organizationId, input.assigneeId, team.visibility, team.id],
    );
    if (!member.rows.length)
      throw new CloudError(
        422,
        "invalid_assignee",
        "Choose a member who can access this team.",
      );
  }
  if (input.cycleId && input.cycleId !== previous?.cycleId) {
    const cycle = (
      await sql.query<{ status: string }>(
        "SELECT status FROM cloud_cycles WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, input.cycleId],
      )
    ).rows[0];
    if (cycle?.status === "closed")
      throw new CloudError(
        422,
        "cycle_closed",
        "Choose a cycle that has not been completed.",
      );
  }
  if (previous && previous.estimate === input.estimate)
    return previous.estimatePoints;
  if (input.estimate === null) return null;
  const card = team.estimateScale.find(
    (entry) => entry.label === input.estimate,
  );
  if (!card || card.points === null)
    throw new CloudError(
      422,
      "invalid_estimate",
      "Choose a point-bearing card from the team's estimate scale.",
    );
  return card.points;
}
