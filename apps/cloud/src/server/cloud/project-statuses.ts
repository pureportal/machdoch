import { randomUUID } from "node:crypto";
import { projectStatuses, type CloudActor } from "../../lib/cloud-contract";
import type {
  CloudProjectStatus,
  ProjectStatusInput,
  ProjectStatusUpdate,
} from "../../lib/cloud-project-status-contract";
import { CloudError, command, requireMembership } from "./access";
import type { CloudDatabase, CloudSql } from "./database";

const statusColumns = "id,name,category,position";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

async function readStatus(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<CloudProjectStatus> {
  const status = (
    await sql.query<CloudProjectStatus & Record<string, unknown>>(
      `SELECT ${statusColumns} FROM cloud_project_statuses WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!status)
    throw new CloudError(404, "not_found", "Project status is unavailable.");
  return status;
}

async function withUniqueName<T>(
  sql: CloudSql,
  write: () => Promise<T>,
): Promise<T> {
  await sql.query("SAVEPOINT project_status");
  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await sql.query("ROLLBACK TO SAVEPOINT project_status");
    throw new CloudError(
      409,
      "conflict",
      "A project status with this name already exists.",
    );
  }
}

export async function readProjectStatuses(
  sql: CloudSql,
  organizationId: string,
): Promise<CloudProjectStatus[]> {
  return (
    await sql.query<CloudProjectStatus & Record<string, unknown>>(
      `SELECT ${statusColumns} FROM cloud_project_statuses WHERE organization_id=$1
       ORDER BY array_position($2::text[],category),position,created_at,id`,
      [organizationId, projectStatuses],
    )
  ).rows;
}

export class CloudProjectStatuses {
  constructor(private readonly database: CloudDatabase) {}

  list(actor: CloudActor): Promise<CloudProjectStatus[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return readProjectStatuses(sql, actor.organizationId);
    });
  }

  create(
    actor: CloudActor,
    commandId: string,
    input: ProjectStatusInput,
  ): Promise<{ status: CloudProjectStatus }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      return command(
        sql,
        actor,
        commandId,
        { kind: "project.status.create", input },
        async () => {
          const id = randomUUID();
          await withUniqueName(sql, () =>
            sql.query(
              `INSERT INTO cloud_project_statuses (organization_id,id,name,category,position)
             SELECT $1,$2,$3,$4,COALESCE(max(position)+1,0) FROM cloud_project_statuses WHERE organization_id=$1`,
              [actor.organizationId, id, input.name, input.category],
            ),
          );
          return { status: await readStatus(sql, actor, id) };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    id: string,
    input: ProjectStatusUpdate,
  ): Promise<CloudProjectStatus> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      const status = await readStatus(sql, actor, id);
      await withUniqueName(sql, () =>
        sql.query(
          "UPDATE cloud_project_statuses SET name=$3,position=$4 WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id, input.name, input.position],
        ),
      );
      return { ...status, ...input };
    });
  }

  remove(actor: CloudActor, id: string, replacementId: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      const status = await readStatus(sql, actor, id);
      if (replacementId === id)
        throw new CloudError(
          422,
          "project_status_replacement",
          "Choose a different status for its projects.",
        );
      const replacement = await readStatus(sql, actor, replacementId);
      const remaining = await sql.query(
        "SELECT 1 FROM cloud_project_statuses WHERE organization_id=$1 AND category=$2 AND id<>$3",
        [actor.organizationId, status.category, id],
      );
      if (!remaining.rows.length)
        throw new CloudError(
          422,
          "project_status_last",
          "Each status category needs at least one status.",
        );
      await sql.query(
        `UPDATE cloud_projects SET status_id=$3,status=$4,revision=revision+1
         WHERE organization_id=$1 AND status_id=$2`,
        [actor.organizationId, id, replacement.id, replacement.category],
      );
      await sql.query(
        "DELETE FROM cloud_project_statuses WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }
}
