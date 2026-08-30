import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createId } from "./crypto";

export type DatabaseRow = Record<string, unknown>;

export class FleetDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.connection.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
    this.ensureManagerId();
  }

  close(): void {
    this.connection.close();
  }

  get(sql: string, ...parameters: SQLInputValue[]): DatabaseRow | undefined {
    return this.connection.prepare(sql).get(...parameters) as
      | DatabaseRow
      | undefined;
  }

  all(sql: string, ...parameters: SQLInputValue[]): DatabaseRow[] {
    return this.connection.prepare(sql).all(...parameters) as DatabaseRow[];
  }

  run(sql: string, ...parameters: SQLInputValue[]): number {
    return Number(this.connection.prepare(sql).run(...parameters).changes);
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  managerId(): string {
    return requiredString(
      this.get("SELECT value FROM metadata WHERE key = 'manager_id'"),
      "value",
    );
  }

  audit(
    occurredAt: number,
    action: string,
    subjectId: string | null,
    outcome: string,
  ): void {
    this.run(
      "INSERT INTO audit_log (occurred_at, action, subject_id, outcome) VALUES (?, ?, ?, ?)",
      occurredAt,
      action,
      subjectId,
      outcome,
    );
  }

  private migrate(): void {
    this.connection.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    if (this.get("SELECT version FROM schema_migrations WHERE version = 1"))
      return;
    const migration = readFileSync(
      new URL("./migrations/001-initial.sql", import.meta.url),
      "utf8",
    );
    this.transaction(() => {
      this.connection.exec(migration);
      this.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)",
        nowSeconds(),
      );
    });
  }

  private ensureManagerId(): void {
    this.run(
      "INSERT OR IGNORE INTO metadata (key, value) VALUES ('manager_id', ?)",
      createId("manager"),
    );
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
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number")
    throw new Error(`Database field ${key} is invalid.`);
  return value;
}
