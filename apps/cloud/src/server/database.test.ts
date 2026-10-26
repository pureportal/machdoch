import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteTestDatabase } from "../test/remote-fixture";
import type { FleetDatabase } from "./database";

let database: FleetDatabase;
beforeAll(async () => {
  database = await createRemoteTestDatabase();
});
afterAll(async () => {
  await database?.close();
});

describe("remote PostgreSQL storage", () => {
  it("retains installation identity on initialization and rolls back nested operations", async () => {
    const id = await database.managerId();
    await database.initialize();
    expect(await database.managerId()).toBe(id);
    await expect(
      database.transaction(async () => {
        await database.run("INSERT INTO metadata VALUES ('rollback','value')");
        await database.transaction(async () => {
          throw new Error("Abort transaction");
        });
      }),
    ).rejects.toThrow("Abort transaction");
    expect(
      await database.get("SELECT value FROM metadata WHERE key='rollback'"),
    ).toBeUndefined();
  });

  it("keeps affected-row counts and parameters distinct from SQL", async () => {
    expect(
      await database.run(
        "INSERT INTO metadata VALUES ($1,$2)",
        "quoted",
        "value'); DELETE FROM metadata; --",
      ),
    ).toBe(1);
    expect(
      await database.run(
        "UPDATE metadata SET value=$1 WHERE key=$2",
        "updated",
        "missing",
      ),
    ).toBe(0);
    expect(await database.managerId()).toMatch(/^manager_/);
  });
});
