import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../lib/cloud-contract";
import {
  defaultSidebarPreferences,
  type SidebarPreferences,
} from "../../lib/cloud-sidebar-contract";
import { CloudSidebar } from "./sidebar";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let sidebar: CloudSidebar;
let owner: CloudActor;
let viewer: CloudActor;

beforeAll(async () => {
  database = await createTestCloudDatabase();
  sidebar = new CloudSidebar(database);
}, 30_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  const actors: CloudActor[] = [];
  for (const role of ["owner", "viewer"]) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, userId, role],
    );
    actors.push({ organizationId, userId });
  }
  [owner, viewer] = actors as [CloudActor, CloudActor];
});

it("keeps sidebar preferences per member, including read-only members", async () => {
  expect(await sidebar.get(viewer)).toEqual(defaultSidebarPreferences);
  const preferences: SidebarPreferences = {
    items: [
      { id: "clients", placement: "show" },
      { id: "pulse", placement: "hide" },
    ],
    hiddenSections: ["devices"],
    hiddenTeamIds: [randomUUID()],
  };
  const key = randomUUID();
  expect(await sidebar.update(viewer, key, preferences)).toEqual(preferences);
  expect(await sidebar.update(viewer, key, preferences)).toEqual(preferences);
  await expect(
    sidebar.update(viewer, key, defaultSidebarPreferences),
  ).rejects.toMatchObject({ code: "command_conflict" });
  expect(await sidebar.get(viewer)).toEqual(preferences);
  expect(await sidebar.get(owner)).toEqual(defaultSidebarPreferences);
  await sidebar.update(viewer, randomUUID(), defaultSidebarPreferences);
  expect(await sidebar.get(viewer)).toEqual(defaultSidebarPreferences);
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE user_id=$1",
    [viewer.userId],
  );
  await expect(sidebar.get(viewer)).rejects.toMatchObject({ status: 403 });
});
