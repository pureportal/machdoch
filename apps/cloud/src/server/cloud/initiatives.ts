import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../lib/cloud-contract";
import type {
  CloudInitiative,
  InitiativeInput,
  InitiativeUpdate,
} from "../../lib/cloud-initiative-contract";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
  teamVisibility,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";

const visibleProjects = `SELECT p.id FROM cloud_projects p
  JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
  JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$2
  WHERE p.organization_id=$1 AND ${teamVisibility}`;

const initiativeColumns = `n.id,n.name,n.description,n.status,n.owner_id AS "ownerId",to_char(n.target_on,'YYYY-MM-DD') AS "targetOn",n.revision,
  COALESCE((SELECT array_agg(l.project_id ORDER BY l.project_id) FROM cloud_initiative_projects l
    WHERE l.organization_id=n.organization_id AND l.initiative_id=n.id AND l.project_id IN (${visibleProjects})),'{}') AS "projectIds",
  (SELECT count(*)::integer FROM cloud_initiative_projects l JOIN cloud_issues i ON i.organization_id=l.organization_id AND i.project_id=l.project_id
    WHERE l.organization_id=n.organization_id AND l.initiative_id=n.id AND l.project_id IN (${visibleProjects}) AND NOT i.archived AND i.state<>'canceled') AS issues,
  (SELECT count(*)::integer FROM cloud_initiative_projects l JOIN cloud_issues i ON i.organization_id=l.organization_id AND i.project_id=l.project_id
    WHERE l.organization_id=n.organization_id AND l.initiative_id=n.id AND l.project_id IN (${visibleProjects}) AND NOT i.archived AND i.state='complete') AS "completedIssues",
  (SELECT u.health FROM cloud_initiative_projects l
    JOIN LATERAL (SELECT x.health FROM cloud_project_updates x WHERE x.organization_id=l.organization_id AND x.project_id=l.project_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) u ON true
    WHERE l.organization_id=n.organization_id AND l.initiative_id=n.id AND l.project_id IN (${visibleProjects})
    ORDER BY CASE u.health WHEN 'off_track' THEN 0 WHEN 'at_risk' THEN 1 ELSE 2 END LIMIT 1) AS health`;

async function readInitiative(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudInitiative> {
  await requireMembership(sql, actor, write ? "planning.edit" : undefined);
  const initiative = (
    await sql.query<CloudInitiative & Record<string, unknown>>(
      `SELECT ${initiativeColumns} FROM cloud_initiatives n WHERE n.organization_id=$1 AND n.id=$3 FOR ${write ? "UPDATE" : "SHARE"} OF n`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!initiative)
    throw new CloudError(404, "not_found", "Initiative is unavailable.");
  return initiative;
}

async function validateInitiative(
  sql: CloudSql,
  actor: CloudActor,
  input: InitiativeInput,
): Promise<void> {
  if (input.ownerId) {
    const owner = await sql.query(
      "SELECT 1 FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled",
      [actor.organizationId, input.ownerId],
    );
    if (!owner.rows.length)
      throw new CloudError(
        422,
        "owner_unavailable",
        "Choose an active organization member as owner.",
      );
  }
  if (!input.projectIds.length) return;
  const visible = (
    await sql.query<{ id: string }>(
      `${visibleProjects} AND p.id=ANY($3::uuid[])`,
      [actor.organizationId, actor.userId, input.projectIds],
    )
  ).rows;
  if (visible.length !== input.projectIds.length)
    throw new CloudError(
      422,
      "invalid_reference",
      "A selected project is unavailable.",
    );
}

async function linkProjects(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  projectIds: string[],
): Promise<void> {
  await sql.query(
    `DELETE FROM cloud_initiative_projects WHERE organization_id=$1 AND initiative_id=$3
    AND project_id IN (${visibleProjects}) AND NOT project_id=ANY($4::uuid[])`,
    [actor.organizationId, actor.userId, id, projectIds],
  );
  await sql.query(
    `INSERT INTO cloud_initiative_projects (organization_id,initiative_id,project_id)
    SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
    [actor.organizationId, id, projectIds],
  );
}

export class CloudInitiatives {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<CloudInitiative[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudInitiative & Record<string, unknown>>(
          `SELECT ${initiativeColumns} FROM cloud_initiatives n WHERE n.organization_id=$1
          ORDER BY CASE n.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,lower(n.name),n.id LIMIT 200`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  get(actor: CloudActor, id: string): Promise<CloudInitiative> {
    return this.database.transaction((sql) => readInitiative(sql, actor, id));
  }

  create(
    actor: CloudActor,
    key: string,
    input: InitiativeInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "planning.edit");
      return command(
        sql,
        actor,
        key,
        { kind: "initiative.create", input },
        async () => {
          await validateInitiative(sql, actor, input);
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_initiatives (organization_id,id,name,description,status,owner_id,target_on) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [
              actor.organizationId,
              id,
              input.name,
              input.description,
              input.status,
              input.ownerId,
              input.targetOn,
            ],
          );
          await linkProjects(sql, actor, id, input.projectIds);
          await recordEvent(sql, actor, "initiative.created", id, 1, {});
          return { id };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: InitiativeUpdate,
  ): Promise<{ id: string; revision: number }> {
    return this.database.transaction(async (sql) => {
      const current = await readInitiative(sql, actor, id, true);
      return command(
        sql,
        actor,
        key,
        { kind: "initiative.update", id, input },
        async () => {
          checkRevision(current.revision, input.revision);
          await validateInitiative(sql, actor, input);
          await sql.query(
            "UPDATE cloud_initiatives SET name=$3,description=$4,status=$5,owner_id=$6,target_on=$7,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.name,
              input.description,
              input.status,
              input.ownerId,
              input.targetOn,
            ],
          );
          await linkProjects(sql, actor, id, input.projectIds);
          await recordEvent(
            sql,
            actor,
            "initiative.updated",
            id,
            current.revision + 1,
            {},
          );
          return { id, revision: current.revision + 1 };
        },
      );
    });
  }
}
