import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { createId } from "./crypto";
import type { CloudDatabase, CloudSql } from "./cloud/database";
import { HttpError } from "./errors";

export type DatabaseRow = Record<string, unknown>;
export type DatabaseValue = string | number | boolean | null | Uint8Array;

export class FleetDatabase {
  private readonly activeSql = new AsyncLocalStorage<CloudSql>();
  private readonly session = new AsyncLocalStorage<string>();

  constructor(private readonly database: CloudDatabase) {}

  withSession<T>(sessionHash: string, operation: () => Promise<T>): Promise<T> {
    return this.session.run(sessionHash, operation);
  }

  close(): Promise<void> {
    return this.database.close();
  }

  async initialize(): Promise<void> {
    const schema = await readFile(
      new URL("./migrations/remote-schema.sql", import.meta.url),
      "utf8",
    );
    await this.database.transaction(async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(1940327614)");
      for (const statement of schema
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        await sql.query(statement);
      await sql.query(
        "INSERT INTO remote.metadata (key,value) VALUES ('manager_id',$1) ON CONFLICT DO NOTHING",
        [createId("manager")],
      );
    });
  }

  async get(
    query: string,
    ...parameters: DatabaseValue[]
  ): Promise<DatabaseRow | undefined> {
    return (await this.all(query, ...parameters))[0];
  }

  all(query: string, ...parameters: DatabaseValue[]): Promise<DatabaseRow[]> {
    return this.withSql(
      async (sql) =>
        (
          await sql.query(
            query,
            parameters.map((value) =>
              value instanceof Uint8Array ? Buffer.from(value) : value,
            ),
          )
        ).rows,
    );
  }

  async run(query: string, ...parameters: DatabaseValue[]): Promise<number> {
    return (await this.all(`${query} RETURNING 1 AS affected`, ...parameters))
      .length;
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeSql.getStore()) return operation();
    return this.withSql(async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(1940327614)");
      return operation();
    });
  }

  async managerId(): Promise<string> {
    return requiredString(
      await this.get("SELECT value FROM metadata WHERE key='manager_id'"),
      "value",
    );
  }

  async audit(
    occurredAt: number,
    action: string,
    subjectId: string | null,
    outcome: string,
  ): Promise<void> {
    await this.run(
      "INSERT INTO audit_log (occurred_at,action,subject_id,outcome) VALUES ($1,$2,$3,$4)",
      occurredAt,
      action,
      subjectId,
      outcome,
    );
  }

  private withSql<T>(operation: (sql: CloudSql) => Promise<T>): Promise<T> {
    const existing = this.activeSql.getStore();
    if (existing) return operation(existing);
    return this.database.transaction(async (sql) => {
      await sql.query("SET LOCAL search_path=remote,public");
      const sessionHash = this.session.getStore();
      if (sessionHash) {
        const authorized = await sql.query(
          `SELECT s.token_hash FROM cloud_sessions s
          JOIN cloud_memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id
          JOIN cloud_users u ON u.id=s.user_id
          JOIN cloud_installation i ON i.id=1 AND i.organization_id=s.organization_id
          WHERE s.token_hash=$1 AND s.authentication_epoch=u.authentication_epoch AND s.membership_epoch=m.authentication_epoch
          AND cloud_session_active(s) AND m.role IN ('owner','admin') AND m.active AND NOT u.disabled
          FOR SHARE OF s,m,u`,
          [sessionHash],
        );
        if (!authorized.rows.length)
          throw new HttpError(401, "Authentication changed. Sign in again.");
      }
      return this.activeSql.run(sql, () => operation(sql));
    });
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function requiredString(
  row: DatabaseRow | undefined,
  key: string,
): string {
  const value = row?.[key];
  if (typeof value !== "string")
    throw new Error(`Database field ${key} is invalid.`);
  return value;
}

export function requiredNumber(
  row: DatabaseRow | undefined,
  key: string,
): number {
  const value = row?.[key];
  if (typeof value !== "number")
    throw new Error(`Database field ${key} is invalid.`);
  return value;
}

export function optionalNumber(row: DatabaseRow, key: string): number | null {
  return row[key] === null ? null : requiredNumber(row, key);
}
