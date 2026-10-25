import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { cloudMigrations, type CloudDatabase, type CloudSql } from "./database";
import type { CloudActor, CloudIssue } from "../../lib/cloud-contract";

export async function testStatusReference(
  database: CloudDatabase,
  actor: CloudActor,
  teamId: string,
  category: CloudIssue["state"],
) {
  return database.transaction(async (sql) => {
    const status = (
      await sql.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM cloud_workflow_statuses WHERE organization_id=$1 AND team_id=$2 AND category=$3 AND NOT archived ORDER BY position LIMIT 1",
        [actor.organizationId, teamId, category],
      )
    ).rows[0];
    if (!status) throw new Error(`Test workflow has no ${category} status`);
    return status;
  });
}

export async function createTestCloudDatabase(): Promise<
  CloudDatabase & { engine: PGlite }
> {
  const engine = new PGlite();
  await engine.exec(
    await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
  );
  for (const name of cloudMigrations)
    await engine.exec(
      await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8"),
    );
  return {
    engine,
    transaction: <T>(operation: (sql: CloudSql) => Promise<T>) =>
      engine.transaction(operation),
    close: () => engine.close(),
  };
}
