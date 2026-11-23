import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  type CloudActor,
} from "../../lib/cloud-contract";
import { cloudMigrations } from "./database";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
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
  for (const role of ["owner", "member", "viewer"]) {
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
  [owner, member, viewer] = actors as [CloudActor, CloudActor, CloudActor];
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

describe("nested teams", () => {
  it("creates sub-teams and rejects cycles", async () => {
    const child = await runtime.planning.createTeam(owner, randomUUID(), {
      name: "AlphaNET Cloud",
      key: "ANC",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
      parentId: teamId,
    });
    const workspace = await runtime.planning.workspace(owner);
    expect(
      workspace.teams.find((team) => team.id === child.id)?.parentId,
    ).toBe(teamId);
    const parent = workspace.teams.find((team) => team.id === teamId)!;
    await expect(
      runtime.administration.updateTeam(owner, randomUUID(), teamId, {
        revision: parent.revision,
        name: parent.name,
        visibility: parent.visibility,
        parentId: child.id,
        memberIds: [owner.userId],
      }),
    ).rejects.toMatchObject({ code: "team_cycle" });
  });
});

describe("settings scopes", () => {
  it("keeps personal settings per user", async () => {
    await runtime.settings.setPersonal(
      member,
      randomUUID(),
      "review.diffLayout",
      "split",
    );
    await runtime.settings.setPersonal(
      viewer,
      randomUUID(),
      "review.diffLayout",
      "unified",
    );
    expect(await runtime.settings.personal(member)).toEqual({
      "review.diffLayout": "split",
    });
    expect(await runtime.settings.personal(viewer)).toEqual({
      "review.diffLayout": "unified",
    });
    expect(await runtime.settings.personal(owner)).toEqual({});
  });

  it("stores workspace settings per organization for settings managers", async () => {
    await expect(
      runtime.settings.setOrganization(
        member,
        randomUUID(),
        "agent.instructions",
        "Be brief.",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await runtime.settings.setOrganization(
      owner,
      randomUUID(),
      "agent.instructions",
      "Be brief.",
    );
    expect(await runtime.settings.organization(viewer)).toEqual({
      "agent.instructions": "Be brief.",
    });
  });

  it("stores team settings per team for team managers", async () => {
    const otherTeamId = (
      await runtime.planning.createTeam(owner, randomUUID(), {
        name: "Other",
        key: "OT",
        visibility: "organization",
        estimateScale: defaultEstimateScale,
      })
    ).id;
    await expect(
      runtime.settings.setTeam(
        member,
        randomUUID(),
        teamId,
        "agent.instructions",
        "Use TypeScript.",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await runtime.settings.setTeam(
      owner,
      randomUUID(),
      teamId,
      "agent.instructions",
      "Use TypeScript.",
    );
    expect(await runtime.settings.team(viewer, teamId)).toEqual({
      "agent.instructions": "Use TypeScript.",
    });
    expect(await runtime.settings.team(viewer, otherTeamId)).toEqual({});
  });

  it("rejects unknown keys and invalid values", async () => {
    await expect(
      runtime.settings.setPersonal(member, randomUUID(), "unknown", true),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      runtime.settings.setPersonal(
        member,
        randomUUID(),
        "review.diffLayout",
        "sideways",
      ),
    ).rejects.toThrow();
  });
});

it("migrates existing teams to top-level teams with empty settings", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("070-settings-scopes.sql");
    for (const name of cloudMigrations.slice(0, index))
      await engine.exec(
        await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8"),
      );
    const organizationId = randomUUID();
    const existingTeamId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_teams (organization_id,id,name,key,visibility,estimate_scale) VALUES ($1,$2,'Team','TM','organization',$3)",
      [organizationId, existingTeamId, JSON.stringify(defaultEstimateScale)],
    );
    for (const name of cloudMigrations.slice(index))
      await engine.exec(
        await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8"),
      );
    expect(
      (
        await engine.query<{ parent_team_id: string | null }>(
          "SELECT parent_team_id FROM cloud_teams WHERE id=$1",
          [existingTeamId],
        )
      ).rows,
    ).toEqual([{ parent_team_id: null }]);
    await expect(
      engine.query(
        "UPDATE cloud_teams SET parent_team_id=id WHERE id=$1",
        [existingTeamId],
      ),
    ).rejects.toThrow();
    await engine.query(
      "INSERT INTO cloud_team_settings (organization_id,team_id,key,value,updated_by) VALUES ($1,$2,'agent.instructions','\"x\"',$3)",
      [organizationId, existingTeamId, randomUUID()],
    );
    expect(
      (await engine.query("SELECT key FROM cloud_team_settings")).rows,
    ).toEqual([{ key: "agent.instructions" }]);
  } finally {
    await engine.close();
  }
}, 120_000);
