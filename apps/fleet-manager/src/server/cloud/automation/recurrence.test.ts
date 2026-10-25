import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { CloudRecurrencePreview } from "./recurrence";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime, actor: CloudActor;
const input = {
  recurrence: {
    kind: "cron",
    expression: "30 2 * * *",
    timezone: "Europe/Berlin",
    start: "2026-01-01T00:00:00Z",
  },
  after: "2026-10-24T22:00:00Z",
  count: 2,
};
beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_users,cloud_organizations CASCADE",
  );
  actor = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Recurrence')",
    [actor.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'viewer@example.test','Viewer',NULL)",
    [actor.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')",
    [actor.organizationId, actor.userId],
  );
  runtime = createCloudRuntime(database, "https://cloud.example.test");
});
it("previews through the isolated evaluator without creating jobs or runs", async () => {
  const result = await runtime.recurrence.preview(actor, input);
  expect(
    result.occurrences.map((value) => new Date(value.at).toISOString()),
  ).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
  expect(result.definition).toMatchObject({ timezoneVersion: "2026e" });
  expect(
    (await database.engine.query("SELECT id FROM cloud_runs")).rows,
  ).toHaveLength(0);
});
it("rejects invalid dates and unsupported clauses with bounded errors", async () => {
  await expect(
    runtime.recurrence.preview(actor, {
      ...input,
      after: "2026-02-31T00:00:00Z",
    }),
  ).rejects.toHaveProperty("code", "invalid_recurrence");
  await expect(
    runtime.recurrence.preview(actor, {
      ...input,
      recurrence: {
        kind: "rrule",
        start: "2026-01-01T00:00:00Z",
        timezone: "UTC",
        rule: "FREQ=DAILY;BYSECOND=2",
      },
    }),
  ).rejects.toHaveProperty("code", "unsupported_rule");
});
it("honors cancellation and denies revoked or cross-organization authority", async () => {
  const canceled = new AbortController();
  canceled.abort(new Error("Canceled"));
  await expect(
    runtime.recurrence.preview(actor, input, canceled.signal),
  ).rejects.toThrow("Canceled");
  await expect(
    runtime.recurrence.preview(
      { ...actor, organizationId: randomUUID() },
      input,
    ),
  ).rejects.toHaveProperty("code", "membership_required");
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
    [actor.organizationId, actor.userId],
  );
  await expect(runtime.recurrence.preview(actor, input)).rejects.toHaveProperty(
    "code",
    "membership_required",
  );
});
it("rechecks authority after evaluation and before delivering the result", async () => {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const resume = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0;
  const preview = new CloudRecurrencePreview({
    close: () => database.close(),
    transaction: async (operation) => {
      if (++calls === 2) {
        entered();
        await resume;
      }
      return database.transaction(operation);
    },
  });
  const result = preview.preview(actor, input);
  const rejected = expect(result).rejects.toHaveProperty(
    "code",
    "membership_required",
  );
  await reached;
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
    [actor.organizationId, actor.userId],
  );
  release();
  await rejected;
});
it("bounds organization concurrency and releases capacity after completion", async () => {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const resume = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0,
    completed = 0;
  const preview = new CloudRecurrencePreview({
    close: () => database.close(),
    transaction: async (operation) => {
      const call = ++calls;
      if (call === 3 || call === 4) {
        if (++completed === 2) entered();
        await resume;
      }
      return database.transaction(operation);
    },
  });
  const first = preview.preview(actor, input),
    second = preview.preview(actor, input);
  await reached;
  await expect(preview.preview(actor, input)).rejects.toHaveProperty(
    "code",
    "recurrence_busy",
  );
  release();
  await Promise.all([first, second]);
  expect((await preview.preview(actor, input)).occurrences).toHaveLength(2);
});
