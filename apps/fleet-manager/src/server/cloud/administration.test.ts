import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
  type CloudRole,
} from "../../lib/cloud-contract";
import { hashOwnerPasswordAsync } from "../crypto";
import { SettingsCipher } from "../settings-crypto";
import { handleCloudApi } from "./api";
import {
  cloudCsrfCookie,
  cloudCsrfHeader,
  cloudSessionCookie,
} from "./identity";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let admin: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let outsider: CloudActor;
let passwordHash: string;
const password = "cloud-verification-password-47";
const origin = "https://cloud.example.test";

async function addMember(
  organizationId: string,
  role: CloudRole,
): Promise<CloudActor> {
  const userId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
    [userId, `${userId}@example.test`, role, passwordHash],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
    [organizationId, userId, role],
  );
  return { organizationId, userId };
}

async function invite(
  actor: CloudActor,
  email: string,
  role: "admin" | "member" | "viewer",
) {
  return runtime.authentication.invitations.create(actor, randomUUID(), {
    organizationId: actor.organizationId,
    email,
    role,
    authentication: { kind: "password" },
  });
}
async function acceptInvitation(token: string, name: string, password: string) {
  const prepared = await runtime.authentication.invitations.prepare(
    token,
    "",
    "",
    "",
  );
  return runtime.authentication.invitationAcceptance.accept(
    {
      confirmationId: prepared.preview.confirmationId,
      sessionId: null,
      name,
      password,
    },
    prepared.nonce,
    "",
    "",
  );
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, origin, {
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
  const otherOrganizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization'),($2,'Other')",
    [organizationId, otherOrganizationId],
  );
  owner = await addMember(organizationId, "owner");
  admin = await addMember(organizationId, "admin");
  member = await addMember(organizationId, "member");
  viewer = await addMember(organizationId, "viewer");
  outsider = await addMember(otherOrganizationId, "owner");
});

describe("cloud administration", () => {
  it("authorizes organization settings and rejects stale edits and cross-tenant member changes", async () => {
    const input = { revision: 1, name: "Updated", accent: "violet" as const };
    const key = randomUUID();
    await runtime.administration.updateOrganization(owner, key, input);
    await runtime.administration.updateOrganization(owner, key, input);
    await expect(
      runtime.administration.updateOrganization(admin, randomUUID(), input),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(runtime.administration.get(member)).rejects.toMatchObject({
      status: 403,
    });
    await expect(runtime.administration.get(viewer)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await runtime.planning.workspace(owner)).organization,
    ).toMatchObject({ name: "Updated", accent: "violet", revision: 2 });
    expect((await runtime.planning.workspace(outsider)).organization.name).toBe(
      "Other",
    );
    await expect(
      runtime.administration.updateMember(
        outsider,
        randomUUID(),
        member.userId,
        { revision: 1, role: "owner", active: true },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps at least one owner and prevents administrators from elevating access", async () => {
    await expect(
      runtime.administration.updateMember(owner, randomUUID(), owner.userId, {
        revision: 1,
        role: "owner",
        active: false,
      }),
    ).rejects.toMatchObject({ code: "last_owner" });
    await expect(
      runtime.administration.updateMember(admin, randomUUID(), member.userId, {
        revision: 1,
        role: "owner",
        active: true,
      }),
    ).rejects.toMatchObject({ code: "owner_required" });
    await expect(
      runtime.administration.updateMember(admin, randomUUID(), owner.userId, {
        revision: 1,
        role: "member",
        active: true,
      }),
    ).rejects.toMatchObject({ code: "owner_required" });
    await runtime.administration.updateMember(
      owner,
      randomUUID(),
      member.userId,
      { revision: 1, role: "owner", active: true },
    );
    await runtime.administration.updateMember(
      owner,
      randomUUID(),
      owner.userId,
      { revision: 1, role: "member", active: true },
    );
    await expect(runtime.administration.get(owner)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await runtime.administration.get(member)).members.find(
        (person) => person.id === member.userId,
      )?.role,
    ).toBe("owner");
  });

  it("revokes sessions and invitations immediately without losing issue or poker history", async () => {
    const session = await runtime.identity.login(
      `${member.userId}@example.test`,
      password,
    );
    const adminInvitation = await invite(
      admin,
      "pending@example.test",
      "member",
    );
    const team = await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    });
    const issue = await runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({
        teamId: team.id,
        title: "Retain history",
        assigneeId: member.userId,
      }),
    );
    const round = await runtime.poker.create(member, randomUUID(), issue.id, 1);
    await runtime.poker.vote(member, randomUUID(), round.id, 1, "3");
    await runtime.administration.updateMember(
      owner,
      randomUUID(),
      member.userId,
      { revision: 1, role: "member", active: false },
    );
    expect(
      await runtime.identity.authenticate(session.sessionToken),
    ).toBeNull();
    await expect(
      runtime.identity.login(`${member.userId}@example.test`, password),
    ).rejects.toMatchObject({ code: "membership_required" });
    await expect(
      runtime.planning.getIssue(member, issue.id),
    ).rejects.toMatchObject({ status: 403 });
    expect(await runtime.planning.history(owner, issue.id)).toHaveLength(1);
    expect((await runtime.poker.get(owner, round.id)).votes).toEqual([]);
    await expect(
      runtime.poker.act(viewer, randomUUID(), round.id, {
        kind: "takeover",
        revision: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await runtime.poker.act(owner, randomUUID(), round.id, {
      kind: "takeover",
      revision: 1,
    });
    await runtime.poker.act(owner, randomUUID(), round.id, {
      kind: "close",
      revision: 2,
    });
    expect((await runtime.poker.get(owner, round.id)).status).toBe("closed");
    await runtime.administration.updateMember(
      owner,
      randomUUID(),
      admin.userId,
      { revision: 1, role: "member", active: true },
    );
    await expect(
      acceptInvitation(adminInvitation.token, "Pending", password),
    ).rejects.toMatchObject({ code: "invitation_unavailable" });
    await runtime.administration.updateMember(
      owner,
      randomUUID(),
      member.userId,
      { revision: 2, role: "member", active: true },
    );
    const fresh = await runtime.identity.login(
      `${member.userId}@example.test`,
      password,
    );
    expect(await runtime.identity.authenticate(fresh.sessionToken)).toEqual(
      member,
    );
    expect(
      await runtime.identity.authenticate(session.sessionToken),
    ).toBeNull();
  });

  it("applies team membership and visibility atomically and rejects stale or foreign members", async () => {
    const team = await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Private",
      key: "PV",
      visibility: "private",
      estimateScale: defaultEstimateScale,
    });
    const issue = await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId: team.id, title: "Private issue" }),
    );
    await expect(
      runtime.planning.getIssue(member, issue.id),
    ).rejects.toMatchObject({ status: 404 });
    const update = {
      revision: 1,
      name: "Private",
      visibility: "private" as const,
      memberIds: [member.userId],
    };
    const key = randomUUID();
    await runtime.administration.updateTeam(owner, key, team.id, update);
    await runtime.administration.updateTeam(owner, key, team.id, update);
    expect((await runtime.planning.getIssue(member, issue.id)).id).toBe(
      issue.id,
    );
    await expect(
      runtime.administration.updateTeam(owner, randomUUID(), team.id, update),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      runtime.administration.updateTeam(owner, randomUUID(), team.id, {
        ...update,
        revision: 2,
        memberIds: [outsider.userId],
      }),
    ).rejects.toMatchObject({ code: "invalid_member" });
    expect(await runtime.administration.teamMembers(owner, team.id)).toEqual([
      member.userId,
    ]);
    await runtime.administration.updateTeam(owner, randomUUID(), team.id, {
      ...update,
      revision: 2,
      memberIds: [],
    });
    await expect(
      runtime.planning.getIssue(member, issue.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("protects invitation revocation, re-invites suspended members, and consumes invitations once", async () => {
    const invitation = await invite(owner, "new@example.test", "admin");
    await expect(
      runtime.administration.revokeInvitation(
        admin,
        randomUUID(),
        invitation.id,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.administration.revokeInvitation(
        outsider,
        randomUUID(),
        invitation.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await runtime.administration.revokeInvitation(
      owner,
      randomUUID(),
      invitation.id,
    );
    await expect(
      acceptInvitation(invitation.token, "New", password),
    ).rejects.toMatchObject({ code: "invitation_unavailable" });
    await runtime.administration.updateMember(
      owner,
      randomUUID(),
      member.userId,
      { revision: 1, role: "member", active: false },
    );
    const rejoin = await invite(
      owner,
      `${member.userId}@example.test`,
      "viewer",
    );
    await acceptInvitation(rejoin.token, "Existing", password);
    await expect(
      acceptInvitation(rejoin.token, "Existing", password),
    ).rejects.toMatchObject({ code: "invitation_unavailable" });
    expect((await runtime.planning.workspace(member)).actor.role).toBe(
      "viewer",
    );
  });

  it("enforces origin, session, CSRF and command keys at the HTTP boundary", async () => {
    const session = await runtime.identity.login(
      `${owner.userId}@example.test`,
      password,
    );
    const cookie = `${cloudSessionCookie}=${session.sessionToken}; ${cloudCsrfCookie}=${session.csrfToken}`;
    const body = JSON.stringify({
      revision: 1,
      name: "HTTP update",
      accent: "emerald",
    });
    const send = (
      headers: Record<string, string>,
      path = "organization",
      method = "PATCH",
    ) =>
      handleCloudApi(
        new Request(`${origin}/api/v1/${path}`, {
          method,
          headers,
          ...(method === "GET" ? {} : { body }),
        }),
        "127.0.0.1",
        runtime,
      );
    const headers = {
      cookie,
      origin,
      "content-type": "application/json",
      [cloudCsrfHeader]: session.csrfToken,
      "idempotency-key": randomUUID(),
    };
    expect((await send({}, "administration", "GET")).status).toBe(401);
    expect(
      (await send({ ...headers, origin: "https://evil.example.test" })).status,
    ).toBe(403);
    expect(
      (await send({ ...headers, [cloudCsrfHeader]: "wrong" })).status,
    ).toBe(403);
    expect(
      (await send({ ...headers, "idempotency-key": "wrong" })).status,
    ).toBe(400);
    const response = await send(headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await send(headers)).status).toBe(200);
    expect((await runtime.planning.workspace(owner)).organization.name).toBe(
      "HTTP update",
    );
  });
});
