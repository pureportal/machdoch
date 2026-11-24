import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type { AgentHandoffInput } from "../../../lib/agent-handoff";
import { SettingsCipher } from "../../settings-crypto";
import { cloudMigrations } from "../database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

const repository = "https://github.com/example/project";
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let viewer: CloudActor;
let projectId: string;
let issueId: string;
let sandboxId: string;
let clientProfileId: string;
let chatProviderId: string;
let codexProviderId: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 7)),
  });
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
    actors.push({ userId, organizationId });
  }
  [owner, viewer] = actors as [CloudActor, CloudActor];
  const teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  projectId = (
    await runtime.projects.create(owner, randomUUID(), {
      teamId,
      name: "Project",
      description: "",
    })
  ).id;
  const provider = (kind: "openai" | "codex-cli", models: string[]) =>
    runtime.aiProviders.create(owner, randomUUID(), {
      name: kind,
      provider: kind,
      region: null,
      models,
      apiKey: kind === "openai" ? "fixture-credential" : "",
      maxOutputTokens: 512,
      dailyTokenBudget: 1_000_000,
      maxConcurrentRequests: 4,
    });
  chatProviderId = (await provider("openai", ["test-model"])).id;
  codexProviderId = (await provider("codex-cli", ["gpt-5.5"])).id;
  const fields = {
    projectId,
    repository,
    autopilot: false,
    maxDurationSeconds: 3600,
    maxTokens: 10000,
    requiredChecks: [],
  };
  sandboxId = (
    await runtime.execution.profiles.create(owner, randomUUID(), {
      ...fields,
      name: "Sandbox",
      target: "cloud",
      providerId: chatProviderId,
      model: "test-model",
    })
  ).id;
  clientProfileId = (
    await runtime.execution.profiles.create(owner, randomUUID(), {
      ...fields,
      name: "Devices",
      target: "client",
      agent: "machdoch",
    })
  ).id;
  issueId = (
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        projectId,
        title: "Implement reconnect",
        description: "Handle reconnect",
        acceptanceCriteria: "No duplicate commands",
      }),
    )
  ).id;
});

async function chatTurn(withContext = true): Promise<string> {
  const submission = await runtime.chat.store.submit(owner, randomUUID(), {
    chatId: null,
    revision: null,
    providerId: chatProviderId,
    model: "test-model",
    prompt: "Make reconnect idempotent",
    context: withContext ? [{ kind: "issue", id: issueId }] : [],
    attachmentIds: [],
  });
  const { turns } = await runtime.chat.store.get(owner, submission.chatId);
  return turns.at(-1)!.id;
}

async function linkedDevice(name: string) {
  const worker = await runtime.execution.workers.register(
    owner,
    clientProfileId,
    name,
  );
  await runtime.execution.clientWorkspaces.bind(worker.token, {
    workspaceId: randomUUID(),
    name: `${name} checkout`,
    repository,
  });
  return worker;
}

function handoff(
  turnId: string,
  overrides: Partial<AgentHandoffInput>,
): AgentHandoffInput {
  return {
    turnId,
    placement: "automatic",
    profileId: null,
    workerId: null,
    harness: "machdoch",
    model: "test-model",
    instructions: "Keep the retry budget at three.",
    ...overrides,
  };
}

it("offers the conversation's issue, enabled executors, online linked devices and providers", async () => {
  const turnId = await chatTurn();
  const laptop = await linkedDevice("Laptop");
  await runtime.execution.workers.register(owner, clientProfileId, "Unlinked");
  const options = await runtime.chat.handoffs.options(owner, turnId);
  expect(options.subject).toEqual({
    kind: "issue",
    id: issueId,
    label: "TM-1",
  });
  expect(options.profiles).toEqual([
    { id: clientProfileId, name: "Devices", target: "client" },
    { id: sandboxId, name: "Sandbox", target: "cloud" },
  ]);
  expect(options.devices).toEqual([
    { id: laptop.id, name: "Laptop", profileId: clientProfileId },
  ]);
  expect(options.providers.map((provider) => provider.kind).sort()).toEqual([
    "codex-cli",
    "openai",
  ]);
  expect(
    await runtime.chat.handoffs.options(owner, await chatTurn(false)),
  ).toEqual({
    subject: null,
    profiles: [],
    devices: [],
    providers: [],
    defaults: { placement: null, harness: null, model: null },
  });
});

it("hands a turn to a cloud sandbox with the chosen harness and model through admission", async () => {
  const turnId = await chatTurn();
  const key = randomUUID();
  const input = handoff(turnId, {
    placement: "sandbox",
    harness: "codex",
    model: "gpt-5.5",
  });
  const { runId } = await runtime.chat.handoffs.start(owner, key, input);
  expect(await runtime.chat.handoffs.start(owner, key, input)).toEqual({
    runId,
  });
  const run = await runtime.execution.runs.get(owner, runId);
  expect(run.state).toBe("queued");
  expect(run.manifest.profile).toMatchObject({
    id: sandboxId,
    target: "cloud",
    providerId: codexProviderId,
    model: "gpt-5.5",
  });
  expect(run.manifest.provider).toMatchObject({
    id: codexProviderId,
    provider: "codex-cli",
  });
  expect(run.manifest.objective).toContain("Keep the retry budget at three.");
  const { turns } = await runtime.chat.store.get(
    owner,
    (await runtime.chat.store.list(owner))[0]!.id,
  );
  expect(turns.at(-1)!.handoffs).toEqual([
    {
      id: expect.any(String),
      runId,
      placement: "sandbox",
      harness: "codex",
      model: "gpt-5.5",
      deviceName: null,
      createdAt: expect.stringMatching(/Z$/),
    },
  ]);
  const worker = await runtime.execution.workers.register(
    owner,
    sandboxId,
    "Sandbox runner",
  );
  const { claim } = await runtime.execution.leases.claim(
    worker.token,
    randomUUID(),
  );
  expect(claim?.runId).toBe(runId);
  expect(claim?.manifest.profile.model).toBe("gpt-5.5");
});

it("pins a linked device so only it claims the run, in an independent checkout", async () => {
  const turnId = await chatTurn();
  const laptop = await linkedDevice("Laptop");
  const desktop = await linkedDevice("Desktop");
  const { runId } = await runtime.chat.handoffs.start(
    owner,
    randomUUID(),
    handoff(turnId, {
      placement: "client",
      workerId: desktop.id,
      harness: "claude",
      model: "opus",
    }),
  );
  expect(
    (await runtime.execution.leases.available(laptop.token)).available,
  ).toBe(false);
  expect(
    (await runtime.execution.leases.claim(laptop.token, randomUUID())).claim,
  ).toBeNull();
  const { claim } = await runtime.execution.leases.claim(
    desktop.token,
    randomUUID(),
  );
  expect(claim?.runId).toBe(runId);
  expect(claim?.manifest.profile).toMatchObject({
    target: "client",
    agent: "claude-cli",
    model: "opus",
  });
  const acceptance = {
    runId,
    attemptId: claim!.attemptId,
    epoch: claim!.epoch,
    environmentId: randomUUID(),
    baseCommit: "a".repeat(40),
  };
  await expect(
    runtime.execution.leases.accept(desktop.token, {
      ...acceptance,
      isolation: "microvm",
    }),
  ).rejects.toMatchObject({ code: "environment_mismatch" });
  expect(
    await runtime.execution.leases.accept(desktop.token, {
      ...acceptance,
      isolation: "independent-checkout",
    }),
  ).toMatchObject({ instruction: "continue" });
  const { turns } = await runtime.chat.store.get(
    owner,
    (await runtime.chat.store.list(owner))[0]!.id,
  );
  expect(turns.at(-1)!.handoffs).toMatchObject([
    { runId, placement: "client", harness: "claude", deviceName: "Desktop" },
  ]);
});

it("rejects handoffs that cannot run, lack a subject or exceed the actor's rights", async () => {
  const turnId = await chatTurn();
  await linkedDevice("Laptop");
  await expect(
    runtime.chat.handoffs.start(
      owner,
      randomUUID(),
      handoff(turnId, { placement: "client", harness: "copilot" }),
    ),
  ).rejects.toMatchObject({
    status: 409,
    code: "handoff_unavailable",
    message: "Linked client cannot run Copilot CLI.",
  });
  await expect(
    runtime.chat.handoffs.start(
      owner,
      randomUUID(),
      handoff(await chatTurn(false), {}),
    ),
  ).rejects.toMatchObject({ code: "handoff_subject" });
  await expect(
    runtime.chat.handoffs.start(viewer, randomUUID(), handoff(turnId, {})),
  ).rejects.toMatchObject({ status: 404 });
  const revoked = await linkedDevice("Old");
  await runtime.execution.workers.revoke(owner, randomUUID(), revoked.id);
  await expect(
    runtime.chat.handoffs.start(
      owner,
      randomUUID(),
      handoff(turnId, { placement: "client", workerId: revoked.id }),
    ),
  ).rejects.toMatchObject({ message: "No linked client is online." });
});

it("adds the handoff table and pinned worker column in migration 083", async () => {
  const engine = new PGlite();
  await engine.exec(
    await readFile(new URL("./../schema.sql", import.meta.url), "utf8"),
  );
  for (const migration of cloudMigrations)
    await engine.exec(
      await readFile(
        new URL(`./../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  const columns = await engine.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
    WHERE (table_name='cloud_runs' AND column_name='pinned_worker_id') OR (table_name='cloud_agent_handoffs' AND column_name='placement')`,
  );
  expect(columns.rows.map((row) => row.table_name).sort()).toEqual([
    "cloud_agent_handoffs",
    "cloud_runs",
  ]);
  await engine.close();
});
