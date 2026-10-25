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
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let issueId: string;
let teamId: string;
beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test");
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
      issueInputSchema.parse({ teamId, title: "Discussion" }),
    )
  ).id;
});

it("retries once, rejects stale edits and preserves attribution without changing the issue's poker revision", async () => {
  const key = randomUUID();
  const comment = await runtime.comments.create(
    member,
    key,
    issueId,
    "First comment",
  );
  expect(
    await runtime.comments.create(member, key, issueId, "First comment"),
  ).toEqual(comment);
  await expect(
    runtime.comments.create(member, key, issueId, "Changed request"),
  ).rejects.toMatchObject({ code: "command_conflict" });
  const editKey = randomUUID();
  await runtime.comments.update(member, editKey, comment.id, {
    kind: "edit",
    revision: 1,
    body: "Edited comment",
  });
  await runtime.comments.update(member, editKey, comment.id, {
    kind: "edit",
    revision: 1,
    body: "Edited comment",
  });
  await expect(
    runtime.comments.update(member, randomUUID(), comment.id, {
      kind: "edit",
      revision: 1,
      body: "Stale",
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await runtime.comments.list(viewer, issueId)).toMatchObject([
    {
      id: comment.id,
      body: "Edited comment",
      authorId: member.userId,
      revision: 2,
    },
  ]);
  expect((await runtime.planning.getIssue(owner, issueId)).revision).toBe(1);
  expect(
    (
      await database.engine.query(
        "SELECT body FROM cloud_comment_history ORDER BY revision",
      )
    ).rows,
  ).toEqual([{ body: "First comment" }, { body: "Edited comment" }]);
});

it("restricts edits to the author and lets administrators remove content without exposing the deleted body", async () => {
  const comment = await runtime.comments.create(
    member,
    randomUUID(),
    issueId,
    "Remove this content",
  );
  await expect(
    runtime.comments.update(owner, randomUUID(), comment.id, {
      kind: "edit",
      revision: 1,
      body: "Impersonation",
    }),
  ).rejects.toMatchObject({ code: "author_required" });
  await expect(
    runtime.comments.create(viewer, randomUUID(), issueId, "No permission"),
  ).rejects.toMatchObject({ status: 403 });
  await runtime.comments.update(owner, randomUUID(), comment.id, {
    kind: "delete",
    revision: 1,
  });
  expect(await runtime.comments.list(member, issueId)).toMatchObject([
    { deleted: true, body: "", authorId: member.userId, revision: 2 },
  ]);
  await expect(
    runtime.comments.update(member, randomUUID(), comment.id, {
      kind: "edit",
      revision: 2,
      body: "Resurrected",
    }),
  ).rejects.toMatchObject({ code: "comment_deleted" });
  const history = (
    await database.engine.query(
      "SELECT actor_id,deleted FROM cloud_comment_history WHERE revision=2",
    )
  ).rows[0];
  expect(history).toEqual({ actor_id: owner.userId, deleted: true });
});

it("enforces current team visibility on reads, mutations and idempotent retries", async () => {
  const key = randomUUID();
  const comment = await runtime.comments.create(
    member,
    key,
    issueId,
    "Confidential",
  );
  await runtime.administration.updateTeam(owner, randomUUID(), teamId, {
    revision: 1,
    name: "Private",
    visibility: "private",
    memberIds: [],
  });
  await expect(runtime.comments.list(member, issueId)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    runtime.comments.create(member, key, issueId, "Confidential"),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.comments.update(member, randomUUID(), comment.id, {
      kind: "delete",
      revision: 1,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.comments.list({ ...owner, organizationId: randomUUID() }, issueId),
  ).rejects.toMatchObject({ status: 404 });
});

it("keeps cursor pages stable when new comments arrive", async () => {
  await database.engine.query(`INSERT INTO cloud_comments (organization_id,id,issue_id,author_id,body,created_at)
    SELECT $1,gen_random_uuid(),$2,$3,'Comment ' || value,clock_timestamp()-interval '1 minute'+value*interval '1 second'
    FROM generate_series(0,51) AS value`, [owner.organizationId, issueId, member.userId]);
  const firstPage = await runtime.comments.list(owner, issueId);
  expect(firstPage).toHaveLength(50);
  await runtime.comments.create(member, randomUUID(), issueId, "New arrival");
  const older = await runtime.comments.list(
    owner,
    issueId,
    firstPage.at(-1)!.id,
  );
  expect(older.map((comment) => comment.body)).toEqual([
    "Comment 1",
    "Comment 0",
  ]);
  expect(
    older.every(
      (comment) => !firstPage.some((previous) => previous.id === comment.id),
    ),
  ).toBe(true);
});

it("blocks archived issue discussion but still permits moderation", async () => {
  const comment = await runtime.comments.create(
    member,
    randomUUID(),
    issueId,
    "Archived discussion",
  );
  const issue = await runtime.planning.getIssue(owner, issueId);
  await runtime.planning.updateIssue(owner, randomUUID(), issueId, {
    ...issueUpdateSchema.strip().parse(issue),
    archived: true,
  });
  await expect(
    runtime.comments.create(member, randomUUID(), issueId, "New comment"),
  ).rejects.toMatchObject({ code: "issue_archived" });
  await expect(
    runtime.comments.update(member, randomUUID(), comment.id, {
      kind: "edit",
      revision: 1,
      body: "Changed",
    }),
  ).rejects.toMatchObject({ code: "issue_archived" });
  await runtime.comments.update(owner, randomUUID(), comment.id, {
    kind: "delete",
    revision: 1,
  });
  expect((await runtime.comments.list(owner, issueId))[0]?.deleted).toBe(true);
});
