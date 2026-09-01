import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FleetDatabase } from "./database";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Fleet database migrations", () => {
  it("upgrades settings delivery status from fetched to applied", () => {
    const directory = mkdtempSync(join(tmpdir(), "machdoch-fleet-database-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    legacy.exec(
      readFileSync(
        new URL("./migrations/001-initial.sql", import.meta.url),
        "utf8",
      ),
    );
    legacy
      .prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1)",
      )
      .run();
    legacy.exec(`
      INSERT INTO instances
        (instance_id, display_name, secret_hash, product_version, protocol_version, enrolled_at)
      VALUES ('instance_test', 'Test', 'hash', '1.0.0', 1, 1);
      INSERT INTO settings_profiles
        (profile_id, name, description, revision, document_json, created_at, updated_at)
      VALUES ('profile_test', 'Test', '', 7, '{}', 1, 1);
      INSERT INTO settings_assignments
        (instance_id, profile_id, assigned_at, last_fetched_revision, last_fetched_at)
      VALUES ('instance_test', 'profile_test', 1, 7, 2);
    `);
    legacy.close();

    const database = new FleetDatabase(path);
    const columns = database
      .all("PRAGMA table_info(settings_assignments)")
      .map((column) => column.name);
    const assignment = database.get(
      `SELECT last_applied_revision, last_applied_at,
              last_sync_revision, last_sync_attempt_at, last_sync_error
       FROM settings_assignments WHERE instance_id = 'instance_test'`,
    );
    database.close();

    expect(columns).toContain("last_applied_revision");
    expect(columns).toContain("last_applied_at");
    expect(columns).not.toContain("last_fetched_revision");
    expect(columns).not.toContain("last_fetched_at");
    expect(assignment).toEqual({
      last_applied_revision: null,
      last_applied_at: null,
      last_sync_revision: null,
      last_sync_attempt_at: null,
      last_sync_error: null,
    });
  });

  it("preserves applied status when adding synchronization diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "machdoch-fleet-database-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const previous = new DatabaseSync(path);
    previous.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    previous.exec(
      readFileSync(
        new URL("./migrations/001-initial.sql", import.meta.url),
        "utf8",
      ),
    );
    previous.exec(
      readFileSync(
        new URL(
          "./migrations/002-settings-application-status.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    previous.exec(`
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1), (2, 2);
      INSERT INTO instances
        (instance_id, display_name, secret_hash, product_version, protocol_version, enrolled_at)
      VALUES ('instance_test', 'Test', 'hash', '1.0.0', 1, 1);
      INSERT INTO settings_profiles
        (profile_id, name, description, revision, document_json, created_at, updated_at)
      VALUES ('profile_test', 'Test', '', 7, '{}', 1, 1);
      INSERT INTO settings_assignments
        (instance_id, profile_id, assigned_at, last_applied_revision, last_applied_at)
      VALUES ('instance_test', 'profile_test', 1, 7, 3);
    `);
    previous.close();

    const database = new FleetDatabase(path);
    const assignment = database.get(
      `SELECT last_applied_revision, last_applied_at,
              last_sync_revision, last_sync_attempt_at, last_sync_error
       FROM settings_assignments WHERE instance_id = 'instance_test'`,
    );
    database.close();

    expect(assignment).toEqual({
      last_applied_revision: 7,
      last_applied_at: 3,
      last_sync_revision: 7,
      last_sync_attempt_at: 3,
      last_sync_error: null,
    });
  });

  it("rejects unknown or non-contiguous migration histories", () => {
    const directory = mkdtempSync(join(tmpdir(), "machdoch-fleet-database-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "fleet.sqlite");
    const incompatible = new DatabaseSync(path);
    incompatible.exec(
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL
       ) STRICT;
       INSERT INTO schema_migrations (version, applied_at) VALUES (2, 1);`,
    );
    incompatible.close();

    expect(() => new FleetDatabase(path)).toThrow(
      "migration history is incompatible",
    );

    const reopened = new DatabaseSync(path);
    reopened.close();
  });
});
