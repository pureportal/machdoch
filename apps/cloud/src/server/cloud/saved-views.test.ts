import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  type CloudActor,
  type CloudRole,
} from "../../lib/cloud-contract";
import {
  savedViewInputSchema,
  type SavedViewInput,
} from "../../lib/cloud-view-contract";
import { cloudMigrations } from "./database";
import { CloudPlanning } from "./planning";
import { CloudSavedViews } from "./saved-views";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let planning: CloudPlanning;
let views: CloudSavedViews;
let owner: CloudActor;
let member: CloudActor;
let outsider: CloudActor;
let viewer: CloudActor;
let privateTeam: string;
let openTeam: string;

async function addMember(
  organizationId: string,
  role: CloudRole,
): Promise<CloudActor> {
  const userId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,'User','unused-test-hash')",
    [userId, `${userId}@example.test`],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
    [organizationId, userId, role],
  );
  return { organizationId, userId };
}

function view(
  name: string,
  scope: SavedViewInput["scope"],
  teamId: string | null = null,
): SavedViewInput {
  return {
    name,
    description: "",
    icon: "bookmark",
    scope,
    teamId,
    filters: { priority: "urgent" },
  };
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
  planning = new CloudPlanning(database);
  views = new CloudSavedViews(database);
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
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Org')",
    [organizationId],
  );
  owner = await addMember(organizationId, "owner");
  member = await addMember(organizationId, "member");
  outsider = await addMember(organizationId, "member");
  viewer = await addMember(organizationId, "viewer");
  privateTeam = (
    await planning.createTeam(owner, randomUUID(), {
      name: "Private",
      key: "PRI",
      visibility: "private",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  openTeam = (
    await planning.createTeam(owner, randomUUID(), {
      name: "Open",
      key: "OPN",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [organizationId, privateTeam, member.userId],
  );
});

describe("saved view scopes", () => {
  it("requires a team exactly for team views", () => {
    expect(savedViewInputSchema.safeParse(view("A", "team")).success).toBe(
      false,
    );
    expect(
      savedViewInputSchema.safeParse(view("A", "personal", randomUUID()))
        .success,
    ).toBe(false);
    expect(
      savedViewInputSchema.safeParse(view("A", "team", randomUUID())).success,
    ).toBe(true);
  });

  it("stores description and icon and shows views by scope", async () => {
    await views.create(member, randomUUID(), {
      ...view("Mine", "personal"),
      description: "Urgent work",
      icon: "flag",
    });
    await views.create(member, randomUUID(), view("Hidden team", "team", privateTeam));
    await views.create(member, randomUUID(), view("Everyone", "workspace"));
    expect(await views.list(member)).toMatchObject([
      { name: "Everyone", scope: "workspace", owned: true },
      { name: "Hidden team", scope: "team", teamId: privateTeam },
      { name: "Mine", description: "Urgent work", icon: "flag" },
    ]);
    expect((await views.list(outsider)).map((entry) => entry.name)).toEqual([
      "Everyone",
    ]);
    await expect(
      views.create(outsider, randomUUID(), view("Nope", "team", privateTeam)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      views.create(viewer, randomUUID(), view("Nope", "workspace")),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("pins team and workspace views as ordered team tabs", async () => {
    const team = await views.create(member, randomUUID(), view("Team", "team", openTeam));
    const workspace = await views.create(member, randomUUID(), view("All", "workspace"));
    const personal = await views.create(member, randomUUID(), view("Mine", "personal"));
    const other = await views.create(member, randomUUID(), view("Other", "team", privateTeam));
    await views.pin(member, randomUUID(), openTeam, [workspace.id, team.id]);
    expect(
      (await views.pinned(outsider, openTeam)).map((entry) => entry.name),
    ).toEqual(["All", "Team"]);
    for (const id of [personal.id, other.id])
      await expect(
        views.pin(member, randomUUID(), openTeam, [id]),
      ).rejects.toMatchObject({ code: "view_not_pinnable" });
    await expect(
      views.pin(viewer, randomUUID(), openTeam, [team.id]),
    ).rejects.toMatchObject({ status: 403 });
    await expect(views.pinned(outsider, privateTeam)).rejects.toMatchObject({
      status: 404,
    });
    await views.update(member, randomUUID(), team.id, view("Team", "personal"));
    expect(
      (await views.pinned(member, openTeam)).map((entry) => entry.name),
    ).toEqual(["All"]);
  });
});

it("migrates shared views to workspace scope and personal views to personal scope", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("071-saved-view-scopes.sql");
    for (const name of cloudMigrations.slice(0, index))
      await engine.exec(
        await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8"),
      );
    const organizationId = randomUUID();
    const userId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Org')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'u@example.test','User','hash')",
      [userId],
    );
    await engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'member')",
      [organizationId, userId],
    );
    await engine.query(
      `INSERT INTO cloud_saved_views (organization_id,id,user_id,name,filters,shared) VALUES
       ($1,$3,$2,'Shared','{"priority":"urgent"}',true),($1,$4,$2,'Private','{}',false)`,
      [organizationId, userId, randomUUID(), randomUUID()],
    );
    for (const name of cloudMigrations.slice(index))
      await engine.exec(
        await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8"),
      );
    expect(
      (
        await engine.query(
          "SELECT name,scope,team_id,description,icon,filters FROM cloud_saved_views ORDER BY name",
        )
      ).rows,
    ).toEqual([
      {
        name: "Private",
        scope: "personal",
        team_id: null,
        description: "",
        icon: "bookmark",
        filters: {},
      },
      {
        name: "Shared",
        scope: "workspace",
        team_id: null,
        description: "",
        icon: "bookmark",
        filters: { priority: "urgent" },
      },
    ]);
  } finally {
    await engine.close();
  }
}, 120_000);
