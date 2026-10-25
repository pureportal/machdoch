import { randomUUID } from "node:crypto";
import { lockExecution } from "./execution/records";
import type {
  CloudActor,
  CloudProject,
  ProjectInput,
  ProjectUpdate,
} from "../../lib/cloud-contract";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireTeam,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";

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
      `SELECT id,team_id AS "teamId",name,description,revision FROM cloud_projects WHERE organization_id=$1 AND id=$2 FOR ${write ? "UPDATE" : "SHARE"}`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
}

export class CloudProjects {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor, id: string): Promise<CloudProject> {
    return this.database.transaction((sql) =>
      readProject(sql, actor, id, false),
    );
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
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_projects (organization_id,id,team_id,name,description) VALUES ($1,$2,$3,$4,$5)",
            [
              actor.organizationId,
              id,
              input.teamId,
              input.name,
              input.description,
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
            project.description === input.description
          )
            return { id };
          await sql.query(
            "UPDATE cloud_projects SET name=$3,description=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id, input.name, input.description],
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
