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
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  channelInputSchema,
  productInputSchema,
} from "../../../lib/cloud-release-contract";
import { defaultChannelRules } from "../../../lib/release-posts";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase, testStatusReference } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;
let providerId: string;
let productId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;

const socialFetch: typeof fetch = async (input) => {
  const url = String(input);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  if (url === "https://www.linkedin.com/oauth/v2/accessToken")
    return json({ access_token: "li-token", expires_in: 5_184_000 });
  if (url === "https://api.linkedin.com/v2/userinfo")
    return json({ sub: "abc123", name: "Ada Owner" });
  if (url.startsWith("https://api.linkedin.com/rest/organizationAcls"))
    return json({ elements: [{ organization: "urn:li:organization:42" }] });
  if (url === "https://api.linkedin.com/rest/organizations/42")
    return json({ localizedName: "machdoch GmbH" });
  return new Response("not found", { status: 404 });
};

function turn(text: string, toolCalls: AgentModelTurn["toolCalls"] = []) {
  return { text, toolCalls, usage: { totalTokens: 4 } };
}

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
  start = vi.fn(async () => turn("Done."));
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    socialFetch,
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => {
        throw new Error("Agent rounds restart with the full transcript.");
      },
    }),
  });
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Platform",
      key: "PLAT",
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
      dailyTokenBudget: 500_000,
      maxConcurrentRequests: 4,
    })
  ).id;
  productId = (
    await runtime.releases.products.create(
      owner,
      randomUUID(),
      productInputSchema.parse({
        name: "machdoch",
        key: "machdoch",
        website: "https://machdoch.app",
        brand: {
          primary: "#6356cf",
          accent: "#7bc8ef",
          background: "#141519",
          foreground: "#eeedf2",
        },
        teamIds: [teamId],
      }),
    )
  ).id;
  await runtime.releases.social.setApp(owner, "linkedin", {
    clientId: "linkedin-client",
    clientSecret: "secret",
    organizationPages: true,
  });
  const authorize = new URL(
    await runtime.releases.social.startConnect(owner, "linkedin"),
  );
  const account = await runtime.releases.social.completeConnect(
    owner,
    "linkedin",
    "code",
    authorize.searchParams.get("state")!,
  );
  for (const input of [
    {
      kind: "linkedin",
      name: "Company page",
      accountId: account.id,
      authorUrn: "urn:li:organization:42",
      authorName: "machdoch GmbH",
    },
    {
      kind: "webhook",
      name: "Slack",
      url: "https://hooks.slack.test/services/T1",
      format: "slack",
    },
  ] as const)
    await runtime.releases.products.createChannel(
      owner,
      randomUUID(),
      productId,
      channelInputSchema.parse({
        rules: defaultChannelRules(input.kind),
        ...input,
      }),
    );
});

async function ship(...titles: string[]) {
  for (const title of titles) {
    const { id } = await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId, title }),
    );
    await runtime.issueChanges.apply(owner, randomUUID(), {
      issues: [{ id }],
      changes: {
        status: await testStatusReference(database, owner, teamId, "complete"),
      },
    });
  }
}

async function release(version: string) {
  const { id } = await runtime.releases.releases.create(owner, randomUUID(), {
    productId,
    version,
    name: "",
    since: null,
    targetDate: null,
  });
  for (let round = 0; round < 4; round++)
    await runtime.automations.dispatcher.tick();
  return id;
}

async function latestRun(automationId: string) {
  return (await runtime.automations.service.runs(owner, { automationId }))[0]!;
}

async function writeCalls() {
  return (
    await database.engine.query<{ id: string; user_prompt: string }>(
      "SELECT c.id,c.user_prompt FROM cloud_inference_calls c JOIN cloud_chat_turns t ON t.organization_id=c.organization_id AND t.id=c.turn_id JOIN cloud_chats ch ON ch.organization_id=t.organization_id AND ch.id=t.chat_id WHERE ch.release_id IS NOT NULL ORDER BY c.created_at",
    )
  ).rows;
}

it("lets Agent configure a LinkedIn workflow that posts once enough has shipped since the last post", async () => {
  const definition = {
    team: "PLAT",
    name: "LinkedIn post for big releases",
    trigger: { kind: "release_created", productIds: [productId] },
    actions: [
      {
        kind: "write_release_posts",
        channelKinds: ["linkedin"],
        providerId,
        model: "fixture-model",
        minimumChanges: 3,
      },
    ],
  };
  start
    .mockResolvedValueOnce(
      turn("", [
        {
          id: "options",
          name: "get_automation_options",
          arguments: { team: "PLAT" },
        },
      ]),
    )
    .mockResolvedValueOnce(
      turn("", [
        {
          id: "webhook",
          name: "propose_automation",
          arguments: {
            ...definition,
            actions: [
              ...definition.actions,
              {
                kind: "send_webhook",
                url: "https://hooks.example.test/posted",
              },
            ],
          },
        },
        { id: "propose", name: "propose_automation", arguments: definition },
      ]),
    )
    .mockResolvedValueOnce(turn("Proposed the workflow."));
  const submission = await runtime.chat.store.submit(member, randomUUID(), {
    chatId: null,
    revision: null,
    providerId,
    model: "fixture-model",
    prompt:
      "I need a new workflow that triggers on a new release and writes a LinkedIn post, but only when the changes since the last LinkedIn post are big enough.",
    context: [],
    attachmentIds: [],
  });
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  expect(start.mock.calls[1]![0].userPrompt).toContain(
    `\\"conversationModel\\":{\\"providerId\\":\\"${providerId}\\",\\"model\\":\\"fixture-model\\"}`,
  );
  const [chatTurn] = (await runtime.chat.store.get(member, submission.chatId))
    .turns;
  expect(chatTurn!.steps.find((step) => step.id === "webhook")).toMatchObject({
    failed: true,
  });
  expect(chatTurn!.actions).toHaveLength(1);
  const proposal = chatTurn!.actions[0]!;
  expect(proposal).toMatchObject({
    kind: "automation",
    state: "pending",
    automationId: null,
    fields: expect.arrayContaining([
      { label: "When", value: "A machdoch release is created" },
      {
        label: "Then",
        value:
          "1. Agent writes the LinkedIn posts once 3 issues shipped since the last post",
      },
    ]),
  });
  expect(await runtime.automations.service.list(owner)).toEqual([]);
  const applied = await runtime.chat.actions.apply(
    member,
    chatTurn!.id,
    proposal.id,
  );
  expect(applied).toMatchObject({
    state: "applied",
    result: { kind: "automation", label: "LinkedIn post for big releases" },
  });
  const [automation] = await runtime.automations.service.list(owner);
  expect(automation).toMatchObject({
    id: applied.result!.id,
    ownerId: member.userId,
    enabled: true,
    trigger: { kind: "release_created", productIds: [productId] },
  });

  await ship("Release studio", "Brand kits");
  await release("1.0");
  expect(await latestRun(automation!.id)).toMatchObject({
    state: "skipped",
    trigger: "release_created",
    error: null,
    steps: [
      {
        state: "skipped",
        detail:
          "Not enough changes since the last post: Company page 2 of 3 issues",
      },
    ],
  });
  expect(await writeCalls()).toEqual([]);

  await ship("Reddit channels", "Video intros");
  const second = await release("1.1");
  const run = await latestRun(automation!.id);
  expect(run).toMatchObject({ state: "succeeded" });
  expect(run.steps[0]).toMatchObject({
    state: "succeeded",
    detail: "Agent is writing Company page (4 issues since the last post)",
    link: `/cloud/releases/${second}`,
  });
  const [write] = await writeCalls();
  expect(write!.user_prompt).toContain("Company page");
  expect(write!.user_prompt).not.toContain("(webhook, id");
  expect(write!.user_prompt).toContain("were not announced there");
  expect(write!.user_prompt).toContain("- 1.0: ");
  expect(write!.user_prompt).toContain("PLAT-1 Release studio");

  const written = await runtime.releases.releases.get(owner, second);
  start
    .mockResolvedValueOnce(
      turn("", [
        {
          id: "post",
          name: "propose_release_post",
          arguments: {
            release: second,
            channel: "Company page",
            body: "Four new things in machdoch 1.1.",
          },
        },
      ]),
    )
    .mockResolvedValueOnce(turn("Drafted."));
  await runtime.inference.worker.runOne(owner.organizationId, write!.id);
  await runtime.releases.dispatcher.tick();
  const drafted = (await runtime.releases.releases.get(owner, second)).posts;
  const linkedIn = drafted.find((post) => post.channelKind === "linkedin")!;
  expect(linkedIn).toMatchObject({
    state: "draft",
    body: "Four new things in machdoch 1.1.",
  });
  expect(drafted.find((post) => post.channelKind === "webhook")!.body).toBe(
    written.posts.find((post) => post.channelKind === "webhook")!.body,
  );
  await runtime.releases.releases.changePost(owner, randomUUID(), linkedIn.id, {
    action: "manual",
    revision: linkedIn.revision,
    url: "https://www.linkedin.com/feed/update/1",
  });

  await ship("Faster search");
  await release("1.2");
  expect(await latestRun(automation!.id)).toMatchObject({
    state: "skipped",
    error: null,
    steps: [
      {
        state: "skipped",
        detail:
          "Not enough changes since the last post: Company page 1 of 3 issues",
      },
    ],
  });
});

it("measures estimate points and keeps release automations from triggering themselves", async () => {
  const { id } = await runtime.automations.service.create(
    member,
    randomUUID(),
    {
      name: "Announce weekly releases",
      teamId,
      trigger: { kind: "manual" },
      conditions: [],
      actions: [
        {
          kind: "prepare_release",
          productId,
          version: "{{date}}",
          name: "",
          providerId: null,
          model: "",
          instructions: "",
        },
        {
          kind: "write_release_posts",
          channelKinds: [],
          providerId,
          model: "fixture-model",
          instructions: "Mention {{release.title}}.",
          measure: "points",
          minimumChanges: 0,
        },
      ],
      dailyLimit: 10,
    },
  );
  const echo = await runtime.automations.service.create(member, randomUUID(), {
    name: "Echo",
    teamId,
    trigger: { kind: "release_created", productIds: [] },
    conditions: [],
    actions: [
      {
        kind: "prepare_release",
        productId,
        version: "echo-{{release.version}}",
        name: "",
        providerId: null,
        model: "",
        instructions: "",
      },
    ],
    dailyLimit: 10,
  });
  await ship("Planning");
  await runtime.automations.service.run(member, randomUUID(), id, {
    issueId: null,
  });
  for (let round = 0; round < 8; round++)
    await runtime.automations.dispatcher.tick();
  const run = await latestRun(id);
  expect(run).toMatchObject({ state: "succeeded" });
  expect(run.steps[1]!.detail).toBe(
    "Agent is writing Company page (0 points since the last post), Slack (0 points since the last post)",
  );
  const [write] = await writeCalls();
  const date = new Date().toISOString().slice(0, 10);
  expect(write!.user_prompt).toContain(`Mention machdoch ${date}.`);
  const versions = (await runtime.releases.releases.list(owner))
    .map((entry) => entry.version)
    .sort();
  expect(versions).toEqual([date, `echo-${date}`]);
  expect(
    await runtime.automations.service.runs(owner, { automationId: echo.id }),
  ).toMatchObject([{ state: "succeeded", trigger: "release_created" }]);
});
