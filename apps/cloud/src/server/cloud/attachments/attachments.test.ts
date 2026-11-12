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
import { issueInputSchema, type CloudActor } from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let outsider: CloudActor;
let providerId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const stream = (bytes: Uint8Array | string) =>
  new Blob([bytes as BlobPart]).stream();

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
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  outsider = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
    [member, "member"],
    [outsider, "member"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${randomUUID()}@example.test`, `${role} user`],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  start = vi.fn();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => {
        throw new Error("Agent rounds restart with the full transcript.");
      },
    }),
  });
  providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 1_000_000,
      maxConcurrentRequests: 4,
    })
  ).id;
});

async function privateIssue() {
  const team = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Product",
    key: "PRD",
    visibility: "private",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [member.organizationId, team.id, member.userId],
  );
  const created = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId: team.id, title: "Checkout layout" }),
  );
  return runtime.planning.getIssue(owner, created.id);
}

function call(name: string, args: Record<string, unknown>): AgentModelTurn {
  return {
    text: "",
    toolCalls: [{ id: `call-${randomUUID()}`, name, arguments: args }],
    usage: { totalTokens: 10 },
  };
}

async function ask(
  actor: CloudActor,
  prompt: string,
  attachmentIds: string[],
  ...rounds: AgentModelTurn[]
) {
  for (const round of rounds) start.mockResolvedValueOnce(round);
  start.mockResolvedValueOnce({
    text: "Done.",
    toolCalls: [],
    usage: { totalTokens: 1 },
  });
  const submission = await runtime.chat.store.submit(actor, randomUUID(), {
    chatId: null,
    revision: null,
    providerId,
    model: "fixture-model",
    prompt,
    context: [],
    attachmentIds,
  });
  await runtime.inference.worker.runOne(
    actor.organizationId,
    submission.requestId,
  );
  return (await runtime.chat.store.get(actor, submission.chatId)).turns.at(-1)!;
}

it("shows attached images and documents to the model and keeps chat files private", async () => {
  const image = await runtime.attachments.upload(
    member,
    null,
    { name: "screen.png", mime: "image/png" },
    stream(png(2, 3)),
  );
  const notes = await runtime.attachments.upload(
    member,
    null,
    { name: "notes.md", mime: "text/markdown" },
    stream("# Plan\nShip the fix on Friday."),
  );
  expect(image).toMatchObject({ kind: "image", width: 2, height: 3 });
  const turn = await ask(member, "What is wrong here?", [image.id, notes.id]);
  expect(turn.state).toBe("complete");
  expect(turn.attachments.map((entry) => entry.name)).toEqual([
    "screen.png",
    "notes.md",
  ]);
  const request = start.mock.calls[0]![0];
  expect(request.imageInputs).toEqual([
    {
      path: `screen.png (attachment ${image.id})`,
      mediaType: "image/png",
      data: Buffer.from(png(2, 3)).toString("base64"),
    },
  ]);
  expect(request.userPrompt).toContain(
    `Attached files: screen.png (image 2×3, attachment ${image.id}); notes.md (document, attachment ${notes.id})`,
  );
  expect(request.userPrompt).toContain("Ship the fix on Friday.");
  await expect(
    runtime.attachments.get(member, image.id),
  ).resolves.toMatchObject({ id: image.id });
  await expect(runtime.attachments.get(owner, image.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    runtime.chat.store.submit(member, randomUUID(), {
      chatId: null,
      revision: null,
      providerId,
      model: "fixture-model",
      prompt: "Again",
      context: [],
      attachmentIds: [image.id],
    }),
  ).rejects.toMatchObject({ code: "attachment_unavailable" });
});

it("lets Agent view issue images and attach chat files in place when a proposal is confirmed", async () => {
  const issue = await privateIssue();
  const diagram = await runtime.attachments.upload(
    owner,
    issue.id,
    { name: "diagram.png", mime: "image/png" },
    stream(png(40, 30)),
  );
  const shot = await runtime.attachments.upload(
    member,
    null,
    { name: "shot.png", mime: "image/png" },
    stream(png(10, 10)),
  );
  const turn = await ask(
    member,
    "Compare my screenshot with the issue diagram and comment.",
    [shot.id],
    call("get_issue", { issue: issue.identifier }),
    call("view_attachment", { attachment: diagram.id }),
    call("propose_comment", {
      issue: issue.identifier,
      body: `The button overlaps:\n\n![shot](/api/v1/attachments/${shot.id})`,
      attachments: [shot.id],
    }),
  );
  const issueOutput = JSON.parse(
    (
      JSON.parse(start.mock.calls[1]![0].userPrompt) as {
        role: string;
        content: string;
      }[]
    ).find((entry) => entry.role === "tool")!.content,
  );
  expect(issueOutput.attachments).toEqual([
    expect.objectContaining({ attachment: diagram.id, name: "diagram.png" }),
  ]);
  expect(
    start.mock.calls[2]![0].imageInputs?.map((entry) => entry.path),
  ).toEqual([
    `shot.png (attachment ${shot.id})`,
    `diagram.png (attachment ${diagram.id})`,
  ]);
  const action = turn.actions[0]!;
  expect(action).toMatchObject({ kind: "comment", attachmentIds: [shot.id] });
  expect(
    (await runtime.chat.actions.apply(member, turn.id, action.id)).state,
  ).toBe("applied");
  const attachments = await runtime.attachments.list(owner, issue.id);
  const copy = attachments.find((entry) => entry.name === "shot.png")!;
  expect(copy).toMatchObject({ source: "agent", width: 10, height: 10 });
  expect(copy.id).not.toBe(shot.id);
  const comments = await runtime.comments.list(owner, issue.id, null);
  expect(comments[0]!.body).toBe(
    `The button overlaps:\n\n![shot](/api/v1/attachments/${copy.id})`,
  );
  expect((await runtime.attachments.bytes(owner, copy.id)).bytes).toEqual(
    Buffer.from(png(10, 10)),
  );
  await expect(runtime.attachments.get(owner, shot.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    runtime.attachments.get(outsider, copy.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (await runtime.chat.actions.apply(member, turn.id, action.id)).state,
  ).toBe("applied");
  expect(await runtime.attachments.list(owner, issue.id)).toHaveLength(2);
});

it("enforces issue access and file types for uploads", async () => {
  const issue = await privateIssue();
  await expect(
    runtime.attachments.upload(
      outsider,
      issue.id,
      { name: "a.png", mime: "image/png" },
      stream(png(1, 1)),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.attachments.upload(
      member,
      issue.id,
      { name: "setup.exe", mime: "application/x-msdownload" },
      stream("MZ"),
    ),
  ).rejects.toMatchObject({ status: 415 });
  await expect(
    runtime.attachments.upload(
      member,
      issue.id,
      { name: "broken.png", mime: "image/png" },
      stream("not an image"),
    ),
  ).rejects.toMatchObject({ code: "attachment_invalid" });
  expect(await runtime.attachments.list(member, issue.id)).toEqual([]);
});

it("accepts files from a client upload link for the issue", async () => {
  const issue = await privateIssue();
  const { token } = await runtime.attachments.createUploadLink(owner, issue.id);
  const video = await runtime.attachments.receiveUpload(
    token,
    { name: "demo.mp4", mime: "video/mp4" },
    stream("video-bytes"),
  );
  expect(video).toMatchObject({
    issueId: issue.id,
    kind: "video",
    source: "client",
  });
  expect(
    (await runtime.attachments.list(member, issue.id)).map(
      (entry) => entry.name,
    ),
  ).toEqual(["demo.mp4"]);
  await expect(
    runtime.attachments.receiveUpload(
      randomBytes(32).toString("base64url"),
      { name: "x.mp4", mime: "video/mp4" },
      stream("x"),
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it("keeps client sessions to owners and administrators", async () => {
  const issue = await privateIssue();
  const turn = await ask(
    member,
    "Implement this on my laptop.",
    [],
    call("list_clients", {}),
  );
  expect(turn.steps[0]).toMatchObject({ tool: "list_clients", failed: true });
  await expect(
    runtime.automations.service.create(member, randomUUID(), {
      name: "Implement on a client",
      teamId: issue.teamId,
      trigger: { kind: "manual" },
      conditions: [],
      actions: [
        {
          kind: "start_client_session",
          instanceId: "instance-1",
          workspace: "/projects/example",
          title: "{{issue.identifier}}",
          prompt: "Implement {{issue.url}}",
          goal: true,
        },
      ],
      dailyLimit: 10,
    }),
  ).rejects.toMatchObject({ status: 403 });
});
