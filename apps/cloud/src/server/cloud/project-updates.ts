import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudProjectUpdate,
  CloudProjectUpdateEntry,
  ProjectUpdateInput,
} from "../../lib/cloud-project-update-contract";
import {
  command,
  recordEvent,
  requireMembership,
  teamVisibility,
} from "./access";
import type { CloudDatabase } from "./database";
import { readProject } from "./projects";

const updateColumns = `u.id,u.project_id AS "projectId",u.health,u.summary,u.body,u.generated,u.author_id AS "authorId",a.name AS author,
  to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

export class CloudProjectUpdates {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, projectId: string): Promise<CloudProjectUpdate[]> {
    return this.database.transaction(async (sql) => {
      await readProject(sql, actor, projectId, false);
      return (
        await sql.query<CloudProjectUpdate & Record<string, unknown>>(
          `SELECT ${updateColumns} FROM cloud_project_updates u JOIN cloud_users a ON a.id=u.author_id
          WHERE u.organization_id=$1 AND u.project_id=$2 ORDER BY u.created_at DESC,u.id DESC LIMIT 50`,
          [actor.organizationId, projectId],
        )
      ).rows;
    });
  }

  latest(actor: CloudActor): Promise<CloudProjectUpdate[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudProjectUpdate & Record<string, unknown>>(
          `SELECT DISTINCT ON (u.project_id) ${updateColumns} FROM cloud_project_updates u
          JOIN cloud_users a ON a.id=u.author_id
          JOIN cloud_projects p ON p.organization_id=u.organization_id AND p.id=u.project_id
          JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
          JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
          WHERE u.organization_id=$1 AND ${teamVisibility}
          ORDER BY u.project_id,u.created_at DESC,u.id DESC`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  feed(actor: CloudActor, limit = 60): Promise<CloudProjectUpdateEntry[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudProjectUpdateEntry & Record<string, unknown>>(
          `SELECT ${updateColumns},p.name AS "projectName",p.team_id AS "teamId" FROM cloud_project_updates u
          JOIN cloud_users a ON a.id=u.author_id
          JOIN cloud_projects p ON p.organization_id=u.organization_id AND p.id=u.project_id
          JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
          JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
          WHERE u.organization_id=$1 AND ${teamVisibility}
          ORDER BY u.created_at DESC,u.id DESC LIMIT $3`,
          [actor.organizationId, actor.userId, limit],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    projectId: string,
    input: ProjectUpdateInput,
    generated = false,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await readProject(sql, actor, projectId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "project.update.create", projectId, input, generated },
        async () => {
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_project_updates (organization_id,id,project_id,author_id,health,summary,body,generated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              actor.organizationId,
              id,
              projectId,
              actor.userId,
              input.health,
              input.summary ?? "",
              input.body,
              generated,
            ],
          );
          await recordEvent(sql, actor, "project.update.created", id, 1, {
            projectId,
            health: input.health,
          });
          return { id };
        },
      );
    });
  }
}
