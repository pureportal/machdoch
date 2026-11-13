import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type {
  AgentModelStartParams,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";
import {
  defaultEstimateScale,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  automationInputSchema,
  type AutomationInput,
} from "../../../lib/cloud-automation-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let teamId: string;
let providerId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;

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
  owner = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [owner.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'owner@example.test','Owner','test')",
    [owner.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [owner.organizationId, owner.userId],
  );
  start = vi.fn(async () => ({
    text: "Done.",
    toolCalls: [],
    usage: { totalTokens: 4 },
  }));
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => {
        throw new Error("Agent rounds restart with the full transcript.");
      },
    }),
  });
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 200000,
      maxConcurrentRequests: 4,
    })
  ).id;
});

function automation(input: Partial<AutomationInput>): AutomationInput {
  return automationInputSchema.parse({
    name: "Automation",
    teamId,
    trigger: { kind: "manual" },
    actions: [{ kind: "comment", body: "Hello" }],
    ...input,
  });
}

function createIssueAction(title: string) {
  return {
    kind: "create_issue" as const,
    title,
    description: "",
    statusId: null,
    priority: "none" as const,
    assigneeId: null,
    labelIds: [],
    subIssue: false,
  };
}

async function settle() {
  for (let round = 0; round < 8; round++)
    await runtime.automations.dispatcher.tick();
}

async function issueTitles() {
  return (
    await runtime.planning.listIssueSummaries(owner, { conditions: [] }, 50)
  ).map((issue) => issue.title);
}

it("reacts to another automation finishing and pauses automations", async () => {
  const source = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      name: "Nightly sync",
      actions: [createIssueAction("Synced")],
    }),
  );
  const target = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({ name: "Reminder", actions: [createIssueAction("Remind")] }),
  );
  await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      name: "Follow-up",
      trigger: {
        kind: "automation_finished",
        automationIds: [source.id],
        outcomes: ["succeeded"],
      },
      actions: [
        createIssueAction("After {{run.automation}}: {{run.outcome}}"),
        {
          kind: "set_automation_enabled",
          automationId: target.id,
          enabled: false,
        },
      ],
    }),
  );
  await runtime.automations.service.run(owner, randomUUID(), source.id, {
    issueId: null,
  });
  await settle();
  expect(await issueTitles()).toEqual(
    expect.arrayContaining(["Synced", "After Nightly sync: succeeded"]),
  );
  expect(
    (await runtime.automations.service.get(owner, target.id)).enabled,
  ).toBe(false);
});

it("ignores finished runs with other outcomes", async () => {
  const source = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({ name: "Source", actions: [createIssueAction("Source")] }),
  );
  await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      name: "On failure",
      trigger: {
        kind: "automation_finished",
        automationIds: [source.id],
        outcomes: ["failed"],
      },
      actions: [createIssueAction("Failed: {{run.error}}")],
    }),
  );
  await runtime.automations.service.run(owner, randomUUID(), source.id, {
    issueId: null,
  });
  await settle();
  expect(await issueTitles()).toEqual(["Source"]);
});

it("runs other automations and stops long chains", async () => {
  const last = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({ name: "Last", actions: [createIssueAction("Last ran")] }),
  );
  const middle = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      name: "Middle",
      actions: [{ kind: "run_automation", automationId: last.id }],
    }),
  );
  const first = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      name: "First",
      actions: [{ kind: "run_automation", automationId: middle.id }],
    }),
  );
  await runtime.automations.service.run(owner, randomUUID(), first.id, {
    issueId: null,
  });
  await settle();
  const [middleRun] = await runtime.automations.service.runs(owner, {
    automationId: middle.id,
  });
  expect(middleRun).toMatchObject({
    trigger: "automation",
    state: "succeeded",
  });
  const [lastRun] = await runtime.automations.service.runs(owner, {
    automationId: last.id,
  });
  expect(lastRun).toMatchObject({ trigger: "automation", state: "succeeded" });
  expect(await issueTitles()).toEqual(["Last ran"]);

  const loop = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({ name: "Loop", actions: [createIssueAction("Loop")] }),
  );
  await runtime.automations.service.update(owner, randomUUID(), loop.id, {
    revision: (await runtime.automations.service.get(owner, loop.id)).revision,
    automation: automation({
      name: "Loop",
      actions: [{ kind: "run_automation", automationId: loop.id }],
    }),
  });
  await runtime.automations.service.run(owner, randomUUID(), loop.id, {
    issueId: null,
  });
  await settle();
  const [loopRun] = await runtime.automations.service.runs(owner, {
    automationId: loop.id,
  });
  expect(loopRun!.steps[0]).toMatchObject({ state: "skipped" });
});

it("lets Agent write Pulse updates with a TL;DR from an automation", async () => {
  const project = await runtime.projects.create(owner, randomUUID(), {
    name: "Checkout",
    teamId,
    description: "",
    status: "active",
  });
  await runtime.pulse.writer.setInstructions(
    owner,
    "Lead with the TL;DR. Mention blockers.",
  );
  const pulse = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      name: "Weekly Pulse",
      actions: [
        {
          kind: "write_project_updates",
          projectIds: [],
          providerId,
          model: "fixture-model",
        },
      ],
    }),
  );
  start
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          id: "read",
          name: "get_project",
          arguments: { project: "Checkout" },
        },
      ],
      usage: { totalTokens: 4 },
    })
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          id: "write",
          name: "propose_project_update",
          arguments: {
            project: project.id,
            health: "at_risk",
            summary: "Payments slip a week because the provider API changed.",
            body: "**Risks** – provider API change.",
          },
        },
      ],
      usage: { totalTokens: 4 },
    })
    .mockResolvedValueOnce({
      text: "Posted.",
      toolCalls: [],
      usage: { totalTokens: 4 },
    });
  await runtime.automations.service.run(owner, randomUUID(), pulse.id, {
    issueId: null,
  });
  await settle();
  const [run] = await runtime.automations.service.runs(owner, {
    automationId: pulse.id,
  });
  expect(run).toMatchObject({ state: "succeeded" });
  const [job] = await runtime.pulse.writer.jobs(owner);
  expect(job).toMatchObject({ state: "waiting", projectIds: [project.id] });
  const call = (
    await database.engine.query<{ id: string; system_prompt: string }>(
      "SELECT id,system_prompt FROM cloud_inference_calls",
    )
  ).rows[0]!;
  await runtime.inference.worker.runOne(owner.organizationId, call.id);
  expect(start.mock.calls[0]![0].userPrompt).toContain(
    "Lead with the TL;DR. Mention blockers.",
  );
  await runtime.pulse.writer.tick();
  const [update] = await runtime.projectUpdates.list(owner, project.id);
  expect(update).toMatchObject({
    health: "at_risk",
    summary: "Payments slip a week because the provider API changed.",
    generated: true,
  });
  expect((await runtime.pulse.writer.jobs(owner))[0]).toMatchObject({
    state: "succeeded",
    detail: "Posted 1 update",
  });
  expect(await runtime.chat.store.list(owner)).toEqual([]);
});
