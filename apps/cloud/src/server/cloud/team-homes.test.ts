import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  type CloudActor,
} from "../../lib/cloud-contract";
import { teamResourceInputSchema } from "../../lib/cloud-team-contract";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let viewer: CloudActor;
let teamId: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
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
  runtime = createCloudRuntime(database, "https://cloud.example.test");
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

it("keeps team resources that editors add and remove", async () => {
  const { id } = await runtime.teamHomes.addResource(
    owner,
    randomUUID(),
    teamId,
    { title: "Runbook", url: "https://docs.example.test/runbook" },
  );
  expect((await runtime.teamHomes.get(viewer, teamId)).resources).toEqual([
    expect.objectContaining({
      id,
      title: "Runbook",
      url: "https://docs.example.test/runbook",
    }),
  ]);
  await expect(
    runtime.teamHomes.addResource(viewer, randomUUID(), teamId, {
      title: "Mine",
      url: "https://example.test",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await runtime.teamHomes.removeResource(owner, teamId, id);
  expect((await runtime.teamHomes.get(owner, teamId)).resources).toEqual([]);
});

it("accepts only web links", () => {
  expect(
    teamResourceInputSchema.safeParse({
      title: "Script",
      url: "javascript:alert(1)",
    }).success,
  ).toBe(false);
  expect(
    teamResourceInputSchema.safeParse({
      title: "Docs",
      url: "http://intranet.example.test/docs",
    }).success,
  ).toBe(true);
});
