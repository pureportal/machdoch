import {
  mkdtempSync,
  existsSync,
  readFileSync,
  renameSync,
  copyFileSync,
  constants,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { hashOwnerPassword, hashSecret } from "../crypto";
import { SettingsCipher } from "../settings-crypto";
import { FleetDatabase } from "../database";
import { createTestCloudDatabase } from "./test-database";
import { initializeInstallation } from "./installation-storage";
import { findLegacyConfiguration, openLegacySource } from "./legacy-source";
import { importLegacySource } from "./legacy-import";
import { resumeImportCleanup } from "./legacy-cleanup";
import { CloudIdentity } from "./identity";
import { emptySettingsDocument } from "../settings";
import { SettingsStore } from "../settings-store";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let directory: string;
let path: string;
let configPath: string;
const password = "Original-owner-password-2026!";
const key = Buffer.alloc(32, 7);

let tables: string;
beforeAll(async () => {
  database = await createTestCloudDatabase();
  await new FleetDatabase(database).initialize();
  tables = await database.transaction(async (sql) =>
    (
      await sql.query<{ name: string }>(
        "SELECT format('%I.%I',schemaname,tablename) AS name FROM pg_tables WHERE schemaname IN ('public','remote') ORDER BY schemaname,tablename",
      )
    ).rows
      .map((row) => row.name)
      .join(","),
  );
}, 20_000);
afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.transaction(async (sql) => {
    await sql.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  });
  directory = mkdtempSync(join(tmpdir(), "machdoch-cutover-"));
  path = join(directory, "source.sqlite");
  configPath = join(directory, "source.json");
  writeFileSync(join(directory, "settings.key"), key.toString("base64url"));
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      externalBaseUrl: "https://cloud.example.test/",
      listen: { address: "127.0.0.1", port: 43188 },
      database: { path },
      settingsManager: { enabled: true, encryptionKeyFile: "settings.key" },
    }),
  );
  const source = new DatabaseSync(path);
  source.exec(
    readFileSync(new URL("./fixtures/legacy.sql", import.meta.url), "utf8"),
  );
  source.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER); INSERT INTO schema_migrations VALUES (1,1),(2,1),(3,1),(4,1),(5,1)",
  );
  source
    .prepare("INSERT INTO owner VALUES (1,?,?,1,1)")
    .run("original-owner", hashOwnerPassword(password));
  source
    .prepare("INSERT INTO metadata VALUES ('manager_id','manager_original')")
    .run();
  source
    .prepare(
      "INSERT INTO instances VALUES ('instance_original','Office',?,'36.0.0',1,1,2,NULL)",
    )
    .run(hashSecret("original-device-secret"));
  source
    .prepare(
      "INSERT INTO settings_profiles VALUES ('profile_original','Work','',1,?,1,1)",
    )
    .run(JSON.stringify(emptySettingsDocument()));
  const encrypted = new SettingsCipher(key).encrypt(
    Buffer.from("original-provider-secret"),
    Buffer.from("profile_original\0api"),
  );
  source
    .prepare(
      "INSERT INTO settings_secrets VALUES ('profile_original','api',?,'cret',1)",
    )
    .run(encrypted);
  source.close();
});

afterEach(async () => {
  if (directory) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("machdoch-cutover-")
    )
      throw new Error("Unexpected test cleanup path.");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("installation cutover", () => {
  it("allows isolated new installations to disable source discovery explicitly", () => {
    expect(findLegacyConfiguration("")).toBeUndefined();
    expect(findLegacyConfiguration(configPath)).toBe(resolve(configPath));
  });
  it("preserves password login, device credentials and decrypted settings before deleting SQLite", async () => {
    const installation = await initializeInstallation(database);
    const result = await importLegacySource(
      database,
      openLegacySource(configPath, "production")!,
      installation,
    );
    expect(result.cleaned).toBe(true);
    expect((await initializeInstallation(database)).origin).toBe(
      "https://cloud.example.test",
    );
    expect(existsSync(path)).toBe(false);
    const identity = new CloudIdentity(database);
    const login = await identity.login("original-owner", password);
    expect(await identity.authenticate(login.sessionToken)).toEqual({
      organizationId: result.organizationId,
      userId: result.userId,
    });
    await database.transaction(async (sql) => {
      expect(
        (await sql.query("SELECT secret_hash FROM remote.instances")).rows[0]!
          .secret_hash,
      ).toBe(hashSecret("original-device-secret"));
      const row = (
        await sql.query<{ ciphertext: Uint8Array }>(
          "SELECT ciphertext FROM remote.settings_secrets",
        )
      ).rows[0]!;
      expect(
        new SettingsCipher(
          Buffer.from(installation.credentials_key, "base64url"),
        )
          .decrypt(
            Buffer.from(row.ciphertext),
            Buffer.from("profile_original\0api"),
          )
          .toString(),
      ).toBe("original-provider-secret");
      expect(
        (await sql.query("SELECT cleaned_at FROM cloud_imports")).rows[0]!
          .cleaned_at,
      ).not.toBeNull();
    });
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(directory, "settings.key"))).toBe(false);
    expect(await resumeImportCleanup(database)).toEqual(
      new Set([resolve(configPath)]),
    );
  });

  it("rolls back the entire import and retains SQLite when a secret cannot be decrypted", async () => {
    const installation = await initializeInstallation(database);
    writeFileSync(
      join(directory, "settings.key"),
      Buffer.alloc(32, 8).toString("base64url"),
    );
    await expect(
      importLegacySource(
        database,
        openLegacySource(configPath, "production")!,
        installation,
      ),
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    await database.transaction(async (sql) => {
      expect((await sql.query("SELECT id FROM cloud_users")).rows).toHaveLength(
        0,
      );
      expect(
        (await sql.query("SELECT instance_id FROM remote.instances")).rows,
      ).toHaveLength(0);
      expect(
        (await sql.query("SELECT source_id FROM cloud_imports")).rows,
      ).toHaveLength(0);
    });
  });

  it("retains a source containing unknown tables", () => {
    const source = new DatabaseSync(path);
    source.exec("CREATE TABLE unrecognized (value TEXT)");
    source.close();
    expect(() => openLegacySource(configPath, "production")).toThrow(
      "unknown tables",
    );
    expect(existsSync(path)).toBe(true);
  });

  it("retains a source with missing required tables", () => {
    const source = new DatabaseSync(path);
    source.exec("DROP TABLE enrollment_grants");
    source.close();
    expect(() => openLegacySource(configPath, "production")).toThrow(
      "missing required tables",
    );
    expect(existsSync(path)).toBe(true);
  });

  it("imports batches without losing audit records or the next sequence value", async () => {
    const installation = await initializeInstallation(database);
    const source = new DatabaseSync(path);
    source.exec("BEGIN");
    const insert = source.prepare(
      "INSERT INTO audit_log (occurred_at,action,subject_id,outcome) VALUES (1,'enroll',?,'success')",
    );
    for (let index = 0; index < 405; index++) insert.run(`device_${index}`);
    source.exec("COMMIT");
    source.close();
    const imported = await importLegacySource(
      database,
      openLegacySource(configPath, "production")!,
      installation,
    );
    expect(imported.counts.audit_log).toBe(405);
    const remote = new FleetDatabase(database);
    await remote.audit(2, "next", null, "success");
    expect(
      await remote.get("SELECT id FROM audit_log WHERE action='next'"),
    ).toEqual({ id: 406 });
  });

  it("resumes ancillary cleanup when interrupted after deleting SQLite", async () => {
    const installation = await initializeInstallation(database);
    let transactions = 0;
    const interrupted = {
      close: () => database.close(),
      transaction: ((operation) => {
        if (++transactions === 3) throw new Error("Interrupted cleanup");
        return database.transaction(operation);
      }) as typeof database.transaction,
    };
    await expect(
      importLegacySource(
        interrupted,
        openLegacySource(configPath, "production")!,
        installation,
      ),
    ).rejects.toThrow("Interrupted cleanup");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    expect(await resumeImportCleanup(database)).toEqual(
      new Set([resolve(configPath)]),
    );
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(directory, "settings.key"))).toBe(false);
    expect(
      await database.transaction(
        async (sql) =>
          (await sql.query("SELECT cleaned_at FROM cloud_imports")).rows[0]!
            .cleaned_at,
      ),
    ).not.toBeNull();
  });

  it("retains ancillary files changed after import", async () => {
    const installation = await initializeInstallation(database);
    const source = openLegacySource(configPath, "production")!;
    writeFileSync(join(directory, "settings.key"), "replacement key");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const imported = await importLegacySource(database, source, installation);
      expect(imported.cleaned).toBe(false);
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(join(directory, "settings.key"), "utf8")).toBe(
        "replacement key",
      );
      await resumeImportCleanup(database);
      expect(readFileSync(join(directory, "settings.key"), "utf8")).toBe(
        "replacement key",
      );
    } finally {
      report.mockRestore();
    }
  });

  it("preserves paused profile delivery and encrypted assignments until explicitly enabled", async () => {
    const installation = await initializeInstallation(database);
    const configuration = JSON.parse(readFileSync(configPath, "utf8"));
    configuration.settingsManager.enabled = false;
    writeFileSync(configPath, JSON.stringify(configuration));
    const source = new DatabaseSync(path);
    source.exec(
      "INSERT INTO settings_assignments (instance_id,profile_id,assigned_at) VALUES ('instance_original','profile_original',1)",
    );
    source.close();
    await importLegacySource(
      database,
      openLegacySource(configPath, "production")!,
      installation,
    );
    const settings = new SettingsStore(new FleetDatabase(database));
    const cipher = new SettingsCipher(
      Buffer.from(installation.credentials_key, "base64url"),
    );
    expect(await settings.deliveryEnabled()).toBe(false);
    expect(await settings.getDelivery(cipher, "instance_original")).toBeNull();
    expect(await settings.listAssignments()).toHaveLength(1);
    await settings.setDeliveryEnabled(true, 2);
    expect(
      (await settings.getDelivery(cipher, "instance_original"))?.secrets.api,
    ).toBe("original-provider-secret");
  });

  it("preserves an email-shaped username without inventing an email address", async () => {
    const installation = await initializeInstallation(database);
    const source = new DatabaseSync(path);
    source.exec("UPDATE owner SET username='owner@example.test'");
    source.close();
    const imported = await importLegacySource(
      database,
      openLegacySource(configPath, "production")!,
      installation,
    );
    const user = await database.transaction(
      async (sql) =>
        (
          await sql.query(
            "SELECT email,login_name FROM cloud_users WHERE id=$1",
            [imported.userId],
          )
        ).rows[0],
    );
    expect(user).toEqual({ email: null, login_name: "owner@example.test" });
    const login = await new CloudIdentity(database).login(
      "owner@example.test",
      password,
    );
    expect(
      await new CloudIdentity(database).authenticate(login.sessionToken),
    ).not.toBeNull();
    await expect(
      database.transaction(async (sql) => {
        await sql.query(
          "INSERT INTO cloud_users(id,email,name,password_hash) VALUES ($1,'owner@example.test','Collision','unused')",
          [crypto.randomUUID()],
        );
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("imports committed WAL records before removing the database and journals", async () => {
    const installation = await initializeInstallation(database);
    const recoveredPath = join(directory, "wal-source.sqlite");
    const source = new DatabaseSync(path);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; UPDATE instances SET display_name='Recovered from WAL'",
      );
      expect(existsSync(`${path}-wal`)).toBe(true);
      copyFileSync(path, recoveredPath, constants.COPYFILE_EXCL);
      copyFileSync(
        `${path}-wal`,
        `${recoveredPath}-wal`,
        constants.COPYFILE_EXCL,
      );
    } finally {
      source.close();
    }
    const configuration = JSON.parse(readFileSync(configPath, "utf8"));
    configuration.database.path = recoveredPath;
    writeFileSync(configPath, JSON.stringify(configuration));
    const imported = await importLegacySource(
      database,
      openLegacySource(configPath, "production")!,
      installation,
    );
    expect(imported.cleaned).toBe(true);
    expect(
      await database.transaction(
        async (sql) =>
          (await sql.query("SELECT display_name FROM remote.instances"))
            .rows[0]!.display_name,
      ),
    ).toBe("Recovered from WAL");
    for (const suffix of ["", "-wal", "-shm"])
      expect(existsSync(`${recoveredPath}${suffix}`)).toBe(false);
  });

  it("does not delete a file that replaces the imported SQLite source", async () => {
    const installation = await initializeInstallation(database);
    const source = openLegacySource(configPath, "production")!;
    const close = source.connection.close.bind(source.connection);
    source.connection.close = () => {
      source.connection.close = close;
      close();
      const importedPath = join(directory, "imported.sqlite");
      expect(dirname(resolve(source.path))).toBe(resolve(directory));
      expect(dirname(resolve(importedPath))).toBe(resolve(directory));
      renameSync(source.path, importedPath);
      writeFileSync(source.path, "unimported replacement");
    };
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await importLegacySource(database, source, installation);
      expect(result.cleaned).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("unimported replacement");
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining("source cleanup"),
        expect.stringContaining("replaced"),
      );
    } finally {
      report.mockRestore();
    }
  });

  it("does not delete source files containing invalid profile documents", async () => {
    const installation = await initializeInstallation(database);
    const source = new DatabaseSync(path);
    source.exec(
      `UPDATE settings_profiles SET document_json='{"instructions":"invalid"}'`,
    );
    source.close();
    await expect(
      importLegacySource(
        database,
        openLegacySource(configPath, "production")!,
        installation,
      ),
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(
      await database.transaction(
        async (sql) => (await sql.query("SELECT id FROM cloud_users")).rows,
      ),
    ).toHaveLength(0);
  });

  it("resumes cleanup after a committed import without duplicating accounts or devices", async () => {
    const installation = await initializeInstallation(database);
    let transactions = 0;
    const interrupted = {
      close: () => database.close(),
      transaction: ((operation) => {
        if (++transactions === 2)
          throw new Error("Injected disconnect after commit");
        return database.transaction(operation);
      }) as typeof database.transaction,
    };
    await expect(
      importLegacySource(
        interrupted,
        openLegacySource(configPath, "production")!,
        installation,
      ),
    ).rejects.toThrow("Injected disconnect");
    expect(existsSync(path)).toBe(true);
    expect(
      (
        await importLegacySource(
          database,
          openLegacySource(configPath, "production")!,
          installation,
        )
      ).cleaned,
    ).toBe(true);
    await database.transaction(async (sql) => {
      expect((await sql.query("SELECT id FROM cloud_users")).rows).toHaveLength(
        1,
      );
      expect(
        (await sql.query("SELECT instance_id FROM remote.instances")).rows,
      ).toHaveLength(1);
    });
  });

  it("does not replace an existing linked device installation", async () => {
    const installation = await initializeInstallation(database);
    await database.transaction(async (sql) => {
      await sql.query(
        "INSERT INTO remote.instances VALUES ('instance_existing','Existing','hash','36.0.0',1,1,NULL,NULL)",
      );
    });
    await expect(
      importLegacySource(
        database,
        openLegacySource(configPath, "production")!,
        installation,
      ),
    ).rejects.toThrow("already contains remote device data");
    expect(existsSync(path)).toBe(true);
  });
});
