import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudMilestone,
  MilestoneInput,
  MilestoneUpdate,
} from "../../lib/cloud-milestone-contract";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";

const columns = `x.id,x.project_id AS "projectId",x.name,to_char(x.target_on,'YYYY-MM-DD') AS "targetOn",x.completed_at IS NOT NULL AS completed,x.revision`;

async function requireProjectTeam(
  sql: CloudSql,
  actor: CloudActor,
  projectId: string,
  write: boolean,
): Promise<void> {
  const project = (
    await sql.query<{ team_id: string }>(
      "SELECT team_id FROM cloud_projects WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, projectId],
    )
  ).rows[0];
  if (!project)
    throw new CloudError(404, "not_found", "Project is unavailable.");
  await requireTeam(sql, actor, project.team_id, write);
}

async function readMilestone(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<CloudMilestone> {
  const milestone = (
    await sql.query<CloudMilestone & Record<string, unknown>>(
      `SELECT ${columns} FROM cloud_project_milestones x WHERE x.organization_id=$1 AND x.id=$2 FOR UPDATE`,
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!milestone)
    throw new CloudError(404, "not_found", "Milestone is unavailable.");
  await requireProjectTeam(sql, actor, milestone.projectId, true);
  return milestone;
}

export class CloudProjectMilestones {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, projectId?: string): Promise<CloudMilestone[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudMilestone & Record<string, unknown>>(
          `SELECT ${columns} FROM cloud_project_milestones x
           JOIN cloud_projects p ON p.organization_id=x.organization_id AND p.id=x.project_id
           JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
           JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
           WHERE x.organization_id=$1 AND ($3::uuid IS NULL OR x.project_id=$3) AND ${teamVisibility}
           ORDER BY x.target_on NULLS LAST,x.created_at,x.id`,
          [actor.organizationId, actor.userId, projectId ?? null],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    projectId: string,
    input: MilestoneInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireProjectTeam(sql, actor, projectId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "milestone.create", projectId, input },
        async () => {
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_project_milestones (organization_id,id,project_id,name,target_on) VALUES ($1,$2,$3,$4,$5)",
            [actor.organizationId, id, projectId, input.name, input.targetOn],
          );
          await recordEvent(sql, actor, "milestone.created", id, 1, {
            projectId,
          });
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: MilestoneUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const milestone = await readMilestone(sql, actor, id);
      return command(
        sql,
        actor,
        key,
        { kind: "milestone.update", id, input },
        async () => {
          checkRevision(milestone.revision, input.revision);
          await sql.query(
            `UPDATE cloud_project_milestones SET name=$3,target_on=$4,
             completed_at=CASE WHEN $5 THEN COALESCE(completed_at,clock_timestamp()) ELSE NULL END,revision=revision+1
             WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              input.name,
              input.targetOn,
              input.completed,
            ],
          );
          await recordEvent(
            sql,
            actor,
            "milestone.changed",
            id,
            milestone.revision + 1,
            { projectId: milestone.projectId },
          );
          return { id };
        },
      );
    });
  }

  remove(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      const milestone = await readMilestone(sql, actor, id);
      await sql.query(
        "DELETE FROM cloud_project_milestones WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
      await recordEvent(
        sql,
        actor,
        "milestone.removed",
        id,
        milestone.revision + 1,
        { projectId: milestone.projectId },
      );
    });
  }
}
