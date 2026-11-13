import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import {
  builtinRoles,
  type CloudPermission,
} from "../../lib/cloud-permissions";
import { hashOwnerPasswordAsync } from "../crypto";
import { SettingsCipher } from "../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let admin: CloudActor;
let member: CloudActor;
let passwordHash: string;
let productTeam: string;
let opsTeam: string;
const password = "cloud-verification-password-47";

async function addMember(
  organizationId: string,
  role: string,
  name = role,
): Promise<CloudActor> {
  const userId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
    [userId, `${userId}@example.test`, name, passwordHash],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
    [organizationId, userId, role],
  );
  return { organizationId, userId };
}

async function joinTeam(actor: CloudActor, teamId: string) {
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [actor.organizationId, teamId, actor.userId],
  );
}

async function createRole(
  actor: CloudActor,
  name: string,
  permissions: CloudPermission[],
  scope: "organization" | "assigned" = "organization",
) {
  return runtime.roles.create(actor, randomUUID(), {
    name,
    description: "",
    scope,
    permissions,
  });
}

function issue(teamId: string, title: string) {
  return issueInputSchema.parse({ teamId, title });
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 17)),
  });
  passwordHash = await hashOwnerPasswordAsync(password);
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
  owner = await addMember(organizationId, "owner");
  admin = await addMember(organizationId, "admin");
  member = await addMember(organizationId, "member");
  for (const [key, name] of [
    ["PRD", "Product"],
    ["OPS", "Operations"],
  ] as const) {
    const { id } = await runtime.planning.createTeam(owner, randomUUID(), {
      name,
      key,
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    });
    if (key === "PRD") productTeam = id;
    else opsTeam = id;
  }
});

describe("cloud roles", () => {
  it("seeds the built-in roles for every organization", async () => {
    const roles = await runtime.roles.list(owner);
    expect(roles.map((role) => role.key)).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
      "guest",
    ]);
    for (const role of roles)
      expect(role.permissions.toSorted()).toEqual(
        builtinRoles[
          role.key as keyof typeof builtinRoles
        ].permissions.toSorted(),
      );
    expect(roles.find((role) => role.key === "admin")?.memberCount).toBe(1);
    await expect(runtime.roles.list(member)).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("applies custom role permissions across the API", async () => {
    const { key } = await createRole(owner, "Commenter", ["comments.write"]);
    const commenter = await addMember(owner.organizationId, key);
    const { id } = await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issue(productTeam, "Checkout loses the basket"),
    );
    await expect(
      runtime.planning.createIssue(
        commenter,
        randomUUID(),
        issue(productTeam, "Sneak"),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      runtime.comments.create(commenter, randomUUID(), id, "Seen on Safari."),
    ).resolves.toMatchObject({ id: expect.any(String) });
    const access = await runtime.roles.mine(commenter);
    expect(access).toMatchObject({
      role: key,
      roleName: "Commenter",
      owner: false,
      scope: "organization",
    });
    expect(access.permissions.map((entry) => entry.key)).toEqual([
      "comments.write",
    ]);
    const workspace = await runtime.planning.workspace(commenter);
    expect(workspace.actor.permissions).toEqual(["comments.write"]);
    expect(workspace.members.map((entry) => entry.id)).toEqual([
      commenter.userId,
    ]);
    expect(workspace.gitProviders).toEqual([]);
  });

  it("keeps people from granting more than they hold", async () => {
    await expect(
      createRole(admin, "People lead", ["members.manage"]),
    ).rejects.toMatchObject({ code: "owner_required" });
    const { key } = await createRole(owner, "Coordinator", [
      "roles.manage",
      "issues.edit",
    ]);
    const coordinator = await addMember(owner.organizationId, key);
    await expect(
      createRole(coordinator, "Reviewer", ["git.act"]),
    ).rejects.toMatchObject({ code: "role_not_grantable" });
    const reviewer = await createRole(coordinator, "Editor", ["issues.edit"]);
    await expect(
      runtime.roles.update(coordinator, randomUUID(), key, {
        revision: 1,
        name: "Coordinator",
        description: "",
        scope: "organization",
        permissions: ["issues.edit"],
      }),
    ).rejects.toMatchObject({ code: "owner_required" });
    await expect(
      runtime.roles.update(owner, randomUUID(), "owner", {
        revision: 1,
        name: "Owner",
        description: "",
        scope: "organization",
        permissions: [],
      }),
    ).rejects.toMatchObject({ code: "role_locked" });
    await expect(
      runtime.administration.updateMember(admin, randomUUID(), member.userId, {
        revision: 1,
        role: "admin",
        active: true,
      }),
    ).rejects.toMatchObject({ code: "owner_required" });
    await expect(
      runtime.administration.updateMember(admin, randomUUID(), member.userId, {
        revision: 1,
        role: "missing-role",
        active: true,
      }),
    ).rejects.toMatchObject({ code: "role_unavailable" });
    await runtime.administration.updateMember(
      admin,
      randomUUID(),
      member.userId,
      { revision: 1, role: reviewer.key, active: true },
    );
    expect((await runtime.roles.mine(member)).roleName).toBe("Editor");
  });

  it("deletes only unused custom roles", async () => {
    await expect(runtime.roles.remove(owner, "guest", 1)).rejects.toMatchObject(
      { code: "role_builtin" },
    );
    const { key } = await createRole(owner, "Temporary", ["issues.edit"]);
    await expect(
      createRole(owner, "temporary", ["issues.edit"]),
    ).rejects.toMatchObject({ code: "role_name_taken" });
    const temporary = await addMember(owner.organizationId, key);
    await expect(runtime.roles.remove(owner, key, 1)).rejects.toMatchObject({
      code: "role_in_use",
    });
    await database.engine.query(
      "DELETE FROM cloud_memberships WHERE user_id=$1",
      [temporary.userId],
    );
    await runtime.roles.remove(owner, key, 1);
    expect(
      (await runtime.roles.list(owner)).some((role) => role.key === key),
    ).toBe(false);
  });
});

describe("guests", () => {
  it("limits guests to the teams they are assigned to", async () => {
    const guest = await addMember(owner.organizationId, "guest", "Guest");
    await joinTeam(guest, productTeam);
    await joinTeam(member, productTeam);
    const unrelated = await addMember(
      owner.organizationId,
      "member",
      "Unrelated",
    );
    const opsIssue = await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issue(opsTeam, "Rotate keys"),
    );
    const workspace = await runtime.planning.workspace(guest);
    expect(workspace.actor).toMatchObject({ role: "guest", scope: "assigned" });
    expect(workspace.teams.map((team) => team.id)).toEqual([productTeam]);
    const visible = workspace.members.map((entry) => entry.id);
    expect(visible).toEqual(
      expect.arrayContaining([guest.userId, member.userId]),
    );
    expect(visible).not.toContain(unrelated.userId);
    expect(visible).not.toContain(admin.userId);
    const own = await runtime.planning.createIssue(
      guest,
      randomUUID(),
      issue(productTeam, "Broken invoice link"),
    );
    await expect(
      runtime.comments.create(guest, randomUUID(), own.id, "Repro attached."),
    ).resolves.toMatchObject({ id: expect.any(String) });
    await expect(
      runtime.planning.createIssue(
        guest,
        randomUUID(),
        issue(opsTeam, "Sneak"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runtime.planning.getIssue(guest, opsIssue.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runtime.planning.createCycle(guest, randomUUID(), {
        teamId: productTeam,
        name: "October",
        startsOn: "2026-10-18",
        endsOn: "2026-11-01",
        timezone: "Europe/Berlin",
        capacity: 20,
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect((await runtime.roles.mine(guest)).teams).toEqual([
      { id: productTeam, key: "PRD", name: "Product" },
    ]);
  });

  it("assigns teams when an administrator changes a member's access", async () => {
    const guest = await addMember(owner.organizationId, "member", "Partner");
    await runtime.administration.updateMember(
      admin,
      randomUUID(),
      guest.userId,
      { revision: 1, role: "guest", active: true, teamIds: [opsTeam] },
    );
    const data = await runtime.administration.get(admin);
    expect(
      data.members.find((entry) => entry.id === guest.userId),
    ).toMatchObject({ role: "guest", roleName: "Guest", teamIds: [opsTeam] });
    expect(
      (await runtime.planning.workspace(guest)).teams.map((team) => team.id),
    ).toEqual([opsTeam]);
  });

  it("adds invited guests to the invited teams", async () => {
    const invitation = await runtime.authentication.invitations.create(
      admin,
      randomUUID(),
      {
        organizationId: admin.organizationId,
        email: "partner@example.test",
        role: "guest",
        teamIds: [productTeam],
        authentication: { kind: "password" },
      },
    );
    const pending = (await runtime.administration.get(admin)).invitations;
    expect(pending).toEqual([
      expect.objectContaining({
        email: "partner@example.test",
        roleName: "Guest",
        teamIds: [productTeam],
      }),
    ]);
    const prepared = await runtime.authentication.invitations.prepare(
      invitation.token,
      "",
      "",
      "",
    );
    expect(prepared.preview).toMatchObject({ roleName: "Guest" });
    await runtime.authentication.invitationAcceptance.accept(
      {
        confirmationId: prepared.preview.confirmationId,
        sessionId: null,
        name: "Partner",
        password,
      },
      prepared.nonce,
      "",
      "",
    );
    const user = (
      await database.engine.query<{ id: string }>(
        "SELECT id FROM cloud_users WHERE email='partner@example.test'",
      )
    ).rows[0]!;
    const workspace = await runtime.planning.workspace({
      organizationId: admin.organizationId,
      userId: user.id,
    });
    expect(workspace.actor.role).toBe("guest");
    expect(workspace.teams.map((team) => team.id)).toEqual([productTeam]);
  });
});
