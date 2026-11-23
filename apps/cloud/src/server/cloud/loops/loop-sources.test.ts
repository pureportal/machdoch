import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { automationInputSchema } from "../../../lib/cloud-automation-contract";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
afterEach(async () => {
  await runtime?.inference.worker.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  const organizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  const actors: CloudActor[] = [];
  for (const role of ["owner", "member"]) {
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
  [owner, member] = actors as [CloudActor, CloudActor];
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
  });
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

async function settle() {
  for (let round = 0; round < 6; round++)
    await runtime.automations.dispatcher.tick();
}

async function sentryLoop(): Promise<string> {
  return (
    await runtime.automations.service.create(
      owner,
      randomUUID(),
      automationInputSchema.parse({
        name: "Sentry triage",
        teamId,
        trigger: { kind: "source_event", source: "sentry", contains: "" },
        actions: [
          {
            kind: "create_issue",
            title: "{{source.title}}",
            description: "{{source.body}}",
          },
        ],
      }),
    )
  ).id;
}

function post(url: string, body: unknown): Promise<Response> {
  return handleCloudApi(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    "203.0.113.1",
    runtime,
  );
}

async function issues(): Promise<{ title: string; description: string }[]> {
  return (
    await database.engine.query<{ title: string; description: string }>(
      "SELECT title,description FROM cloud_issues WHERE organization_id=$1 ORDER BY title",
      [owner.organizationId],
    )
  ).rows;
}

async function lastRejection(source: string) {
  return (await runtime.automations.sources.list(owner)).find(
    (state) => state.source === source,
  )!.lastRejection?.reason;
}

it("lists every trusted trigger source with its trust count and lets admins toggle and rotate intake secrets", async () => {
  const loopId = await sentryLoop();
  const sources = runtime.automations.sources;
  expect(
    (await sources.list(owner)).map(({ source, enabled, trustedBy }) => ({
      source,
      enabled,
      trustedBy,
    })),
  ).toEqual([
    { source: "webhook", enabled: true, trustedBy: 0 },
    { source: "email", enabled: false, trustedBy: 0 },
    { source: "github", enabled: true, trustedBy: 0 },
    { source: "gitlab", enabled: true, trustedBy: 0 },
    { source: "sentry", enabled: false, trustedBy: 1 },
    { source: "grafana", enabled: false, trustedBy: 0 },
    { source: "teams", enabled: false, trustedBy: 0 },
    { source: "slack", enabled: false, trustedBy: 0 },
  ]);
  await expect(sources.list(member)).rejects.toMatchObject({ status: 403 });
  await expect(sources.rotate(owner, "github")).rejects.toMatchObject({
    status: 422,
    code: "loop_source_secret",
  });
  await sources.setEnabled(owner, "sentry", true);
  const first = await sources.rotate(owner, "sentry");
  expect(first.url).toBe(
    `https://cloud.example.test/api/v1/loops/sources/${owner.organizationId}/sentry/${first.secret}`,
  );
  const second = await sources.rotate(owner, "sentry");
  const sentry = (await sources.list(owner)).find(
    (state) => state.source === "sentry",
  )!;
  expect(sentry).toMatchObject({ enabled: true, configured: true });
  expect(sentry.rotatedAt).not.toBeNull();

  const stale = await post(first.url, { message: "old" });
  expect(stale.status).toBe(401);
  expect(await lastRejection("sentry")).toBe("invalid_secret");

  const accepted = await post(second.url, {
    data: { issue: { title: "TypeError in checkout", culprit: "cart.ts" } },
  });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ queued: 1 });
  await settle();
  expect(await issues()).toEqual([
    { title: "TypeError in checkout", description: "cart.ts" },
  ]);
  const runs = await runtime.automations.service.runs(owner, {
    automationId: loopId,
  });
  expect(runs.map((run) => [run.trigger, run.state])).toEqual([
    ["source_event", "succeeded"],
  ]);
}, 60_000);

it("rejects events from sources that are off, untrusted or paused and records the reason", async () => {
  const loopId = await sentryLoop();
  const sources = runtime.automations.sources;
  const { url } = await sources.rotate(owner, "sentry");
  const event = { message: "Disk full" };

  const disabled = await post(url, event);
  expect(disabled.status).toBe(409);
  expect(await disabled.json()).toMatchObject({
    code: "loop_source_disabled",
  });
  expect(await lastRejection("sentry")).toBe("source_disabled");

  await sources.setEnabled(owner, "sentry", true);
  const loop = await runtime.automations.loops.get(owner, loopId);
  await runtime.automations.loops.updateConfig(owner, randomUUID(), loopId, {
    revision: loop.revision,
    config: { ...loop.config, trustedSources: [] },
  });
  expect((await post(url, event)).status).toBe(202);
  await settle();
  expect(await issues()).toEqual([]);
  expect(await lastRejection("sentry")).toBe("untrusted");
  expect(
    (
      await database.engine.query(
        "SELECT loop_id AS \"loopId\",reason FROM cloud_loop_source_rejections WHERE organization_id=$1 AND reason='untrusted'",
        [owner.organizationId],
      )
    ).rows,
  ).toEqual([{ loopId, reason: "untrusted" }]);

  const settings = await runtime.automations.loops.getSettings(owner);
  const {
    revision,
    centsPerThousandTokens: _rate,
    usage: _usage,
    ...rest
  } = settings;
  await runtime.automations.loops.updateSettings(owner, randomUUID(), {
    revision,
    settings: { ...rest, enabled: false },
  });
  const paused = await post(url, event);
  expect(paused.status).toBe(409);
  expect(await paused.json()).toMatchObject({ code: "loop_loops_disabled" });
  expect(await lastRejection("sentry")).toBe("loops_disabled");

  expect(
    (
      await post(
        `https://cloud.example.test/api/v1/loops/sources/${owner.organizationId}/github/${"a".repeat(43)}`,
        event,
      )
    ).status,
  ).toBe(404);
}, 60_000);
