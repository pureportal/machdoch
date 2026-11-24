import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudProjectUpdate,
  CloudProjectUpdateEntry,
  ProjectUpdateInput,
} from "../../lib/cloud-project-update-contract";
import {
  CloudError,
  command,
  recordEvent,
  requireMembership,
  teamVisibility,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";
import { notifyProjectLead } from "./notifications";
import { readProject } from "./projects";

const updateColumns = `u.id,u.project_id AS "projectId",u.health,u.summary,u.body,u.generated,u.author_id AS "authorId",a.name AS author,
  to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

async function readDraft(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<{ projectId: string }> {
  const draft = (
    await sql.query<{ projectId: string }>(
      `SELECT project_id AS "projectId" FROM cloud_project_updates WHERE organization_id=$1 AND id=$2 AND draft FOR UPDATE`,
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!draft) throw new CloudError(404, "not_found", "Draft is unavailable.");
  await readProject(sql, actor, draft.projectId, true);
  return draft;
}

export const projectUpdateReminderBatchSize = 50;

export class CloudProjectUpdates {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor, projectId: string): Promise<CloudProjectUpdate[]> {
    return this.database.transaction(async (sql) => {
      await readProject(sql, actor, projectId, false);
      return (
        await sql.query<CloudProjectUpdate & Record<string, unknown>>(
          `SELECT ${updateColumns} FROM cloud_project_updates u JOIN cloud_users a ON a.id=u.author_id
          WHERE u.organization_id=$1 AND u.project_id=$2 AND NOT u.draft ORDER BY u.created_at DESC,u.id DESC LIMIT 50`,
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
          WHERE u.organization_id=$1 AND NOT u.draft AND ${teamVisibility}
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
          WHERE u.organization_id=$1 AND NOT u.draft AND ${teamVisibility}
          ORDER BY u.created_at DESC,u.id DESC LIMIT $3`,
          [actor.organizationId, actor.userId, limit],
        )
      ).rows;
    });
  }

  drafts(actor: CloudActor, projectId: string): Promise<CloudProjectUpdate[]> {
    return this.database.transaction(async (sql) => {
      await readProject(sql, actor, projectId, true);
      return (
        await sql.query<CloudProjectUpdate & Record<string, unknown>>(
          `SELECT ${updateColumns} FROM cloud_project_updates u JOIN cloud_users a ON a.id=u.author_id
          WHERE u.organization_id=$1 AND u.project_id=$2 AND u.draft ORDER BY u.created_at DESC,u.id DESC`,
          [actor.organizationId, projectId],
        )
      ).rows;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    projectId: string,
    input: ProjectUpdateInput,
    options: { generated?: boolean; draft?: boolean } = {},
  ): Promise<{ id: string }> {
    const generated = options.generated ?? false;
    const draft = options.draft ?? false;
    return this.database.transaction(async (sql) => {
      const project = await readProject(sql, actor, projectId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "project.update.create", projectId, input, generated, draft },
        async () => {
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_project_updates (organization_id,id,project_id,author_id,health,summary,body,generated,draft) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              actor.organizationId,
              id,
              projectId,
              actor.userId,
              input.health,
              input.summary ?? "",
              input.body,
              generated,
              draft,
            ],
          );
          if (draft) {
            if (project.leadId)
              await notifyProjectLead(sql, {
                organizationId: actor.organizationId,
                projectId,
                teamId: project.teamId,
                leadId: project.leadId,
                kind: "project_update_drafted",
                detail: input.summary ?? "",
              });
          } else
            await recordEvent(sql, actor, "project.update.created", id, 1, {
              projectId,
              health: input.health,
            });
          return { id };
        },
      );
    });
  }

  publish(
    actor: CloudActor,
    key: string,
    id: string,
    input: ProjectUpdateInput,
  ): Promise<{ id: string }> {
    return this.database.transaction((sql) =>
      command(
        sql,
        actor,
        key,
        { kind: "project.update.publish", id, input },
        async () => {
          const { projectId } = await readDraft(sql, actor, id);
          await sql.query(
            `UPDATE cloud_project_updates SET draft=false,author_id=$3,health=$4,summary=$5,body=$6,created_at=clock_timestamp()
            WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              actor.userId,
              input.health,
              input.summary ?? "",
              input.body,
            ],
          );
          await recordEvent(sql, actor, "project.update.created", id, 1, {
            projectId,
            health: input.health,
          });
          return { id };
        },
      ),
    );
  }

  discard(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await readDraft(sql, actor, id);
      await sql.query(
        "DELETE FROM cloud_project_updates WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }

  remindDue(): Promise<number> {
    return this.database.transaction(async (sql) => {
      const due = (
        await sql.query<{
          organizationId: string;
          projectId: string;
          teamId: string;
          leadId: string;
          dueAt: Date;
        }>(
          `SELECT p.organization_id AS "organizationId",p.id AS "projectId",p.team_id AS "teamId",p.lead_id AS "leadId",d.due AS "dueAt"
          FROM cloud_projects p CROSS JOIN LATERAL (
            SELECT greatest(p.update_cadence_since,(SELECT max(u.created_at) FROM cloud_project_updates u
              WHERE u.organization_id=p.organization_id AND u.project_id=p.id AND NOT u.draft))
              + CASE p.update_cadence WHEN 'weekly' THEN interval '7 days' WHEN 'biweekly' THEN interval '14 days' ELSE interval '1 month' END AS due
          ) d
          WHERE p.update_cadence<>'none' AND p.lead_id IS NOT NULL AND p.status NOT IN ('completed','canceled')
          AND d.due<=clock_timestamp() AND (p.update_reminded_at IS NULL OR p.update_reminded_at<d.due)
          ORDER BY d.due LIMIT $1 FOR UPDATE OF p SKIP LOCKED`,
          [projectUpdateReminderBatchSize],
        )
      ).rows;
      for (const project of due) {
        await sql.query(
          "UPDATE cloud_projects SET update_reminded_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
          [project.organizationId, project.projectId],
        );
        await notifyProjectLead(sql, {
          ...project,
          kind: "project_update_due",
          detail: "",
        });
      }
      return due.length;
    });
  }
}
