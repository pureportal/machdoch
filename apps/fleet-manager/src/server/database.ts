import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { createId } from "./crypto";

export type DatabaseRow = Record<string, unknown>;

export class FleetDatabase {
  readonly connection: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      securePath(directory, 0o700);
    }
    this.connection = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    try {
      if (path !== ":memory:") securePath(path, 0o600);
      this.connection.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
      );
      this.migrate();
      this.ensureManagerId();
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close(): void {
    this.statements.clear();
    this.connection.close();
  }

  get(sql: string, ...parameters: SQLInputValue[]): DatabaseRow | undefined {
    return this.statement(sql).get(...parameters) as DatabaseRow | undefined;
  }

  all(sql: string, ...parameters: SQLInputValue[]): DatabaseRow[] {
    return this.statement(sql).all(...parameters) as DatabaseRow[];
  }

  run(sql: string, ...parameters: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...parameters).changes);
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) {
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    const statement = this.connection.prepare(sql);
    if (this.statements.size >= 128)
      this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
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
    const migrations = [
      "001-initial.sql",
      "002-settings-application-status.sql",
      "003-settings-sync-status.sql",
    ];
    const appliedVersions = this.all(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).map((row) => requiredNumber(row, "version"));
    if (
      appliedVersions.some(
        (version, index) =>
          !Number.isSafeInteger(version) || version !== index + 1,
      ) ||
      appliedVersions.length > migrations.length
    ) {
      throw new Error("Fleet database migration history is incompatible.");
    }
    migrations.forEach((filename, index) => {
      const version = index + 1;
      if (
        this.get(
          "SELECT version FROM schema_migrations WHERE version = ?",
          version,
        )
      ) {
        return;
      }
      const migration = readFileSync(
        new URL(`./migrations/${filename}`, import.meta.url),
        "utf8",
      );
      this.transaction(() => {
        this.connection.exec(migration);
        this.run(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          version,
          nowSeconds(),
        );
      });
    });
  }

  private ensureManagerId(): void {
    this.run(
      "INSERT OR IGNORE INTO metadata (key, value) VALUES ('manager_id', ?)",
      createId("manager"),
    );
  }
}

function securePath(path: string, mode: number): void {
  if (process.platform !== "win32") chmodSync(path, mode);
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
