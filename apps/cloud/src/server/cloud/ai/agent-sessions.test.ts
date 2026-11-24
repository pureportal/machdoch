import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { AgentModelTurn } from "@machdoch/model-runtime/types";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  AgentSessions,
  ChatMessage,
} from "../../../lib/cloud-chat-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { handleChatApi } from "./chat-api";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let providerId: string;
const answer: AgentModelTurn = {
  text: "Done",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
};
const message = (prompt: string): ChatMessage => ({
  chatId: null,
  revision: null,
  providerId,
  model: "fixture-model",
  prompt,
  context: [],
  attachmentIds: [],
});

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
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
    [member, "member"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    modelAdapterFactory: async () => ({
      startTurn: async () => answer,
      continueTurn: async () => answer,
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
      maxConcurrentRequests: 20,
    })
  ).id;
});

async function finished(actor: CloudActor, prompt: string) {
  const submission = await runtime.chat.store.submit(
    actor,
    randomUUID(),
    message(prompt),
  );
  await runtime.inference.worker.runOne(
    actor.organizationId,
    submission.requestId,
  );
  return submission;
}

const titles = (sessions: AgentSessions) => ({
  running: sessions.running.map(({ title, state }) => ({ title, state })),
  recent: sessions.recent.map(({ title, state }) => ({ title, state })),
});

it("lists the caller's running and recent agent sessions for the session tray", async () => {
  await finished(member, "Summarize the backlog");
  const archived = await finished(member, "Old question");
  const detail = await runtime.chat.store.get(member, archived.chatId);
  await runtime.chat.store.update(member, randomUUID(), archived.chatId, {
    revision: detail.chat.revision,
    archived: true,
  });
  await finished(owner, "Owner only");
  const running = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message("Plan the next cycle"),
  );
  const sessions = await runtime.chat.store.sessions(member);
  expect(titles(sessions)).toEqual({
    running: [{ title: "Plan the next cycle", state: "queued" }],
    recent: [{ title: "Summarize the backlog", state: "complete" }],
  });
  expect(sessions.running[0]).toMatchObject({
    id: running.chatId,
    startedAt: expect.stringMatching(/Z$/),
  });
  const response = await handleChatApi(
    runtime,
    new Request("https://cloud.example.test/api/v1/agent-sessions"),
    member,
  );
  expect(titles((await response.json()) as AgentSessions)).toEqual(
    titles(sessions),
  );
});

it("keeps sessions running without an open panel and caps the recent list", async () => {
  const running = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message("Triage new bugs"),
  );
  expect(
    (await runtime.chat.store.sessions(member)).running.map(
      (session) => session.id,
    ),
  ).toEqual([running.chatId]);
  await runtime.inference.worker.runOne(
    member.organizationId,
    running.requestId,
  );
  const settled = await runtime.chat.store.sessions(member);
  expect(settled.running).toEqual([]);
  expect(settled.recent[0]).toMatchObject({
    id: running.chatId,
    state: "complete",
  });
  for (let index = 0; index < 9; index += 1)
    await finished(member, `Question ${index}`);
  const capped = await runtime.chat.store.sessions(member);
  expect(capped.recent).toHaveLength(8);
  expect(capped.recent[0]!.title).toBe("Question 8");
});
