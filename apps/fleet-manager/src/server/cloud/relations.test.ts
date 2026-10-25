import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  issueUpdateSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor,
  member: CloudActor,
  viewer: CloudActor,
  stranger: CloudActor;
let teamId: string, issueId: string;
beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test");
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID(),
    other = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization'),($2,'Other')",
    [organizationId, other],
  );
  const actors: CloudActor[] = [];
  for (const [organization, role] of [
    [organizationId, "owner"],
    [organizationId, "member"],
    [organizationId, "viewer"],
    [other, "owner"],
  ]) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${userId}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organization, userId, role],
    );
    actors.push({ organizationId: organization!, userId });
  }
  [owner, member, viewer, stranger] = actors as [
    CloudActor,
    CloudActor,
    CloudActor,
    CloudActor,
  ];
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  issueId = (
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId, title: "Issue", estimate: "3" }),
    )
  ).id;
});

async function makeIssue(title: string, team = teamId) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId: team, title }),
  );
}
async function link(
  source: string,
  target: string,
  kind: "parent" | "child" | "blocks" | "blocked_by" | "related" = "related",
  actor = owner,
) {
  return runtime.relations.add(actor, randomUUID(), source, {
    kind,
    targetId: target,
    sourceRevision: 1,
    targetRevision: 1,
  });
}

it("keeps direction, canonical related identity, and retries stable without changing issue or poker snapshots", async () => {
  const other = await makeIssue("Other");
  const third = await makeIssue("Third");
  const round = await runtime.poker.create(owner, randomUUID(), issueId, 1);
  const input = {
    kind: "related" as const,
    targetId: other.id.toUpperCase(),
    sourceRevision: 1,
    targetRevision: 1,
  };
  const key = randomUUID();
  const relation = await runtime.relations.add(member, key, issueId, input);
  expect(await runtime.relations.add(member, key, issueId, input)).toEqual(
    relation,
  );
  expect(await link(other.id, issueId)).toEqual(relation);
  await link(issueId, third.id, "child");
  await link(issueId, third.id, "blocks");
  expect(await runtime.relations.list(viewer, third.id)).toMatchObject([
    { kind: "parent", issue: { id: issueId } },
    { kind: "blocked_by", issue: { id: issueId } },
  ]);
  await runtime.relations.remove(member, randomUUID(), issueId, relation.id);
  expect(await runtime.relations.add(member, key, issueId, input)).toEqual(
    relation,
  );
  expect(await runtime.relations.list(owner, other.id)).toEqual([]);
  const next = await link(other.id, issueId);
  expect(next.id).not.toBe(relation.id);
  await runtime.relations.remove(member, randomUUID(), issueId, relation.id);
  expect(await runtime.relations.list(owner, other.id)).toHaveLength(1);
  expect((await runtime.planning.getIssue(owner, issueId)).revision).toBe(1);
  expect((await runtime.poker.get(owner, round.id)).stale).toBe(false);
});

it("rejects self links, multiple parents and transitive cycles while allowing separate graph meanings", async () => {
  const other = await makeIssue("Other"),
    third = await makeIssue("Third");
  await expect(link(issueId, issueId)).rejects.toMatchObject({
    code: "relation_self",
  });
  await link(issueId, other.id, "child");
  await link(other.id, third.id, "child");
  await expect(link(third.id, issueId, "child")).rejects.toMatchObject({
    code: "relation_cycle",
  });
  await expect(link(issueId, third.id, "child")).rejects.toMatchObject({
    code: "relation_parent",
  });
  await link(third.id, other.id, "blocks");
  await link(other.id, issueId, "blocks");
  await expect(link(issueId, third.id, "blocks")).rejects.toMatchObject({
    code: "relation_cycle",
  });
  await link(issueId, other.id);
  await link(other.id, third.id);
  await link(third.id, issueId);
});

it("omits inaccessible edges and refuses cross-tenant, private, viewer and revoked access", async () => {
  const privateTeam = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Private",
    key: "PR",
    visibility: "private",
    estimateScale: defaultEstimateScale,
  });
  const hidden = await makeIssue("Secret", privateTeam.id),
    visible = await makeIssue("Visible");
  const secretLink = await link(issueId, hidden.id, "blocked_by");
  await link(issueId, visible.id);
  const actual = await runtime.relations.list(member, issueId);
  expect(actual).toHaveLength(1);
  expect(JSON.stringify(actual)).not.toContain(hidden.id);
  expect(JSON.stringify(actual)).not.toContain(secretLink.id);
  await expect(
    link(issueId, hidden.id, "related", member),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.relations.remove(member, randomUUID(), issueId, secretLink.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    link(issueId, visible.id, "blocks", viewer),
  ).rejects.toMatchObject({ status: 403 });
  await expect(runtime.relations.list(stranger, issueId)).rejects.toMatchObject(
    { status: 404 },
  );
  const otherTeam = await runtime.planning.createTeam(stranger, randomUUID(), {
    name: "Other",
    key: "OT",
    visibility: "organization",
    estimateScale: defaultEstimateScale,
  });
  const otherIssue = await runtime.planning.createIssue(
    stranger,
    randomUUID(),
    issueInputSchema.parse({ teamId: otherTeam.id, title: "Other tenant" }),
  );
  await expect(link(issueId, otherIssue.id)).rejects.toMatchObject({
    status: 404,
  });
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
    [member.organizationId, member.userId],
  );
  await expect(runtime.relations.list(member, issueId)).rejects.toMatchObject({
    status: 403,
  });
});

it("creates sub-issues atomically and rejects stale or archived endpoints without partial writes", async () => {
  const key = randomUUID();
  const input = {
    parentRevision: 1,
    issue: issueInputSchema.parse({ teamId, title: "Child" }),
  };
  const child = await runtime.relations.createChild(
    member,
    key,
    issueId,
    input,
  );
  expect(
    await runtime.relations.createChild(member, key, issueId, input),
  ).toEqual(child);
  expect(await runtime.relations.list(member, child.id)).toMatchObject([
    { kind: "parent", issue: { id: issueId } },
  ]);
  const parent = await runtime.planning.getIssue(owner, issueId);
  await runtime.planning.updateIssue(
    owner,
    randomUUID(),
    issueId,
    issueUpdateSchema.strip().parse({ ...parent, title: "Updated" }),
  );
  await expect(
    runtime.relations.createChild(member, randomUUID(), issueId, input),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await runtime.planning.listIssues(owner)).toHaveLength(2);
  await expect(link(issueId, child.id)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  await runtime.planning.updateIssue(
    owner,
    randomUUID(),
    issueId,
    issueUpdateSchema.strip().parse({ ...parent, revision: 2, archived: true }),
  );
  await expect(
    runtime.relations.add(owner, randomUUID(), issueId, {
      kind: "related",
      targetId: child.id,
      sourceRevision: 3,
      targetRevision: 1,
    }),
  ).rejects.toMatchObject({ code: "issue_archived" });
  const relation = (await runtime.relations.list(owner, issueId))[0]!;
  await runtime.relations.remove(member, randomUUID(), issueId, relation.id);
  expect(await runtime.relations.list(member, issueId)).toEqual([]);
});

it("bounds graph traversal and rolls back child allocation when the parent's link capacity is exhausted", async () => {
  await database.engine.query(
    `INSERT INTO cloud_issues(organization_id,id,team_id,identifier,title,description,acceptance_criteria,state,priority,status_id)
    SELECT $1,md5('related-'||n)::uuid,$2,'EX-'||n,'Bulk','','','backlog','none',(SELECT default_status_id FROM cloud_team_workflows WHERE organization_id=$1 AND team_id=$2) FROM generate_series(1,1000) n`,
    [owner.organizationId, teamId],
  );
  await database.engine.query(
    `INSERT INTO cloud_issue_relations(organization_id,id,kind,source_id,target_id,actor_id)
    SELECT $1,md5('edge-'||n)::uuid,'parent',$2,md5('related-'||n)::uuid,$3 FROM generate_series(1,1000) n`,
    [owner.organizationId, issueId, owner.userId],
  );
  const before = (
    await database.engine.query(
      "SELECT next_issue_number FROM cloud_teams WHERE id=$1",
      [teamId],
    )
  ).rows;
  await expect(
    runtime.relations.createChild(member, randomUUID(), issueId, {
      parentRevision: 1,
      issue: issueInputSchema.parse({ teamId, title: "Overflow" }),
    }),
  ).rejects.toMatchObject({ code: "relation_capacity" });
  expect(
    (
      await database.engine.query(
        "SELECT next_issue_number FROM cloud_teams WHERE id=$1",
        [teamId],
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_issues WHERE title='Overflow'",
      )
    ).rows,
  ).toEqual([]);
  await database.engine.exec("DELETE FROM cloud_issue_relations");
  await database.engine.query(
    `INSERT INTO cloud_issues(organization_id,id,team_id,identifier,title,description,acceptance_criteria,state,priority,status_id)
    SELECT $1,md5('deep-'||n)::uuid,$2,'DP-'||n,'Deep','','','backlog','none',(SELECT default_status_id FROM cloud_team_workflows WHERE organization_id=$1 AND team_id=$2) FROM generate_series(1,10002) n`,
    [owner.organizationId, teamId],
  );
  await database.engine.query(
    `INSERT INTO cloud_issue_relations(organization_id,id,kind,source_id,target_id,actor_id)
    SELECT $1,md5('path-'||n)::uuid,'blocks',md5('deep-'||n)::uuid,md5('deep-'||(n+1))::uuid,$2 FROM generate_series(1,10001) n`,
    [owner.organizationId, owner.userId],
  );
  const deep = (
    await database.engine.query<{ id: string }>(
      "SELECT md5('deep-1')::uuid AS id",
    )
  ).rows[0]!;
  await expect(link(issueId, deep.id, "blocks")).rejects.toMatchObject({
    code: "relation_cycle",
  });
});
