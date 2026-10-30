import { randomUUID } from "node:crypto";
import { lockExecution } from "./execution/records";
import type {
  CloudActor,
  CloudProject,
  CloudProjectProgress,
  ProjectInput,
  ProjectUpdate,
} from "../../lib/cloud-contract";
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
import { projectColumns } from "./planning-queries";

async function readProject(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write: boolean,
): Promise<CloudProject> {
  const identity = (
    await sql.query<{ team_id: string }>(
      "SELECT team_id FROM cloud_projects WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!identity)
    throw new CloudError(404, "not_found", "Project is unavailable.");
  await requireTeam(sql, actor, identity.team_id, write);
  return (
    await sql.query<CloudProject & Record<string, unknown>>(
      `SELECT ${projectColumns} FROM cloud_projects WHERE organization_id=$1 AND id=$2 FOR ${write ? "UPDATE" : "SHARE"}`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
}

async function requireLead(
  sql: CloudSql,
  actor: CloudActor,
  leadId: string | null,
): Promise<void> {
  if (!leadId) return;
  const lead = await sql.query(
    "SELECT user_id FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2 AND active",
    [actor.organizationId, leadId],
  );
  if (!lead.rows.length)
    throw new CloudError(
      422,
      "lead_unavailable",
      "Choose an active organization member as project lead.",
    );
}

export class CloudProjects {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor, id: string): Promise<CloudProject> {
    return this.database.transaction((sql) =>
      readProject(sql, actor, id, false),
    );
  }

  progress(actor: CloudActor): Promise<CloudProjectProgress[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudProjectProgress & Record<string, unknown>>(
          `SELECT p.id AS "projectId",count(i.id) FILTER (WHERE i.state<>'canceled')::integer AS total,
            count(i.id) FILTER (WHERE i.state IN ('active','review','blocked'))::integer AS started,
            count(i.id) FILTER (WHERE i.state='complete')::integer AS completed,
            COALESCE(sum(i.estimate_points) FILTER (WHERE i.state<>'canceled'),0)::double precision AS points,
            COALESCE(sum(i.estimate_points) FILTER (WHERE i.state='complete'),0)::double precision AS "completedPoints"
          FROM cloud_projects p JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
          JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
          LEFT JOIN cloud_issues i ON i.organization_id=p.organization_id AND i.project_id=p.id AND NOT i.archived
          WHERE p.organization_id=$1 AND ${teamVisibility} GROUP BY p.id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: ProjectInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireTeam(sql, actor, input.teamId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "project.create", input },
        async () => {
          await requireLead(sql, actor, input.leadId ?? null);
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_projects (organization_id,id,team_id,name,description,status,lead_id,starts_on,target_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              actor.organizationId,
              id,
              input.teamId,
              input.name,
              input.description,
              input.status ?? "planned",
              input.leadId ?? null,
              input.startsOn ?? null,
              input.targetOn ?? null,
            ],
          );
          await recordEvent(sql, actor, "project.created", id, 1, {});
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: ProjectUpdate,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const project = await readProject(sql, actor, id, true);
      return command(
        sql,
        actor,
        key,
        { kind: "project.update", id, input },
        async () => {
          checkRevision(project.revision, input.revision);
          if (
            project.name === input.name &&
            project.description === input.description &&
            project.status === input.status &&
            project.leadId === input.leadId &&
            project.startsOn === input.startsOn &&
            project.targetOn === input.targetOn
          )
            return { id };
          if (input.leadId !== project.leadId)
            await requireLead(sql, actor, input.leadId);
          await sql.query(
            "UPDATE cloud_projects SET name=$3,description=$4,status=$5,lead_id=$6,starts_on=$7,target_on=$8,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.name,
              input.description,
              input.status,
              input.leadId,
              input.startsOn,
              input.targetOn,
            ],
          );
          await recordEvent(
            sql,
            actor,
            "project.changed",
            id,
            project.revision + 1,
            {},
          );
          return { id };
        },
      );
    });
  }
}
