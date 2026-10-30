import { readFile } from "node:fs/promises";
import { Pool } from "pg";

export const cloudMigrations = [
  "002-administration.sql",
  "003-cycle-lifecycle.sql",
  "004-comments.sql",
  "005-execution.sql",
  "006-providers.sql",
  "007-chat.sql",
  "008-mcp.sql",
  "009-execution-providers.sql",
  "010-task-inference.sql",
  "011-repository-transfers.sql",
  "012-artifacts.sql",
  "013-client-workspaces.sql",
  "014-runtime-inference-options.sql",
  "015-labels.sql",
  "016-magic-links.sql",
  "017-sso.sql",
  "018-session-management.sql",
  "019-invitation-confirmation.sql",
  "020-schedules.sql",
  "021-task-schedules.sql",
  "022-schedule-lifecycle.sql",
  "023-issue-relations.sql",
  "024-team-workflows.sql",
  "025-installation.sql",
  "026-cutover.sql",
  "027-client-agents.sql",
  "028-chat-issue.sql",
  "029-project-planning.sql",
];

export interface CloudSql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface CloudDatabase {
  transaction<T>(operation: (sql: CloudSql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresCloudDatabase implements CloudDatabase {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      application_name: "machdoch.cloud",
    });
    this.pool.on("error", (error) =>
      console.error("Cloud database connection failed:", error.message),
    );
  }

  async transaction<T>(operation: (sql: CloudSql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        "SET LOCAL idle_in_transaction_session_timeout = '15s'",
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error
            ? rollbackError
            : new Error("Rollback failed.");
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async migrate(): Promise<void> {
    const schema = await readFile(
      new URL("./schema.sql", import.meta.url),
      "utf8",
    );
    await this.transaction(async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(1940327611)");
      await sql.query(
        "CREATE TABLE IF NOT EXISTS cloud_schema (version integer PRIMARY KEY CHECK (version = 1))",
      );
      const applied = await sql.query("SELECT version FROM cloud_schema");
      if (!applied.rows.length) {
        await sql.query(schema);
        await sql.query("INSERT INTO cloud_schema VALUES (1)");
      }
      await sql.query(
        "CREATE TABLE IF NOT EXISTS cloud_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const name of cloudMigrations) {
        if (
          (
            await sql.query("SELECT name FROM cloud_migrations WHERE name=$1", [
              name,
            ])
          ).rows.length
        )
          continue;
        await sql.query(
          await readFile(
            new URL(`./migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
        await sql.query("INSERT INTO cloud_migrations (name) VALUES ($1)", [
          name,
        ]);
      }
    });
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
