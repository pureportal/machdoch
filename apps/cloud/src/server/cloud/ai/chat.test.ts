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
import type { ChatMessage } from "../../../lib/cloud-chat-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { maximumInferenceAnswerBytes } from "./inference-records";
import { agentToolSpecs } from "./agent-tools";
import { providerUpdateSchema } from "@machdoch/fleet-protocol/cloud-providers";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let providerId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;
const key = randomBytes(32);
const answer: AgentModelTurn = {
  text: "A bounded answer",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
};
const message = (): ChatMessage => ({
  chatId: null,
  revision: null,
  providerId,
  model: "fixture-model",
  prompt: "How does a cycle work?",
  context: [],
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
  start = vi.fn(async () => answer);
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(key),
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
      dailyTokenBudget: 200000,
      maxConcurrentRequests: 4,
    })
  ).id;
});

it("admits a request once, charges verified usage and supplies workspace tools without inherited agents", async () => {
  const commandId = randomUUID();
  const input = message();
  const submission = await runtime.chat.store.submit(member, commandId, input);
  expect(await runtime.chat.store.submit(member, commandId, input)).toEqual(
    submission,
  );
  expect(
    (await runtime.chat.store.budget(owner, providerId)).reservedTokens,
  ).toBeGreaterThan(256);
  await Promise.all([
    runtime.inference.worker.runOne(
      member.organizationId,
      submission.requestId,
    ),
    runtime.inference.worker.runOne(
      member.organizationId,
      submission.requestId,
    ),
  ]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]![0]).toMatchObject({
    tools: agentToolSpecs,
    parallelAgentMode: "disabled",
    maxRequestAttempts: 1,
    maxOutputTokens: 256,
    storeResponses: false,
  });
  const detail = await runtime.chat.store.get(member, submission.chatId);
  expect(detail.turns).toHaveLength(1);
  expect(detail.turns[0]).toMatchObject({
    state: "complete",
    answer: answer.text,
  });
  expect(await runtime.chat.store.budget(owner, providerId)).toMatchObject({
    usedTokens: 16,
    reservedTokens: 0,
    activeRequests: 0,
  });
  expect(await runtime.chat.store.submit(member, commandId, input)).toEqual(
    submission,
  );
  await expect(
    runtime.chat.store.submit(member, commandId, {
      ...input,
      prompt: "Changed",
    }),
  ).rejects.toMatchObject({ code: "command_conflict" });
});

it("preserves private conversation history and rejects concurrent stale messages", async () => {
  const first = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(member.organizationId, first.requestId);
  const detail = await runtime.chat.store.get(member, first.chatId);
  const next = {
    ...message(),
    chatId: first.chatId,
    revision: detail.chat.revision,
    prompt: "What happens next?",
  };
  const second = await runtime.chat.store.submit(member, randomUUID(), next);
  await expect(
    runtime.chat.store.submit(member, randomUUID(), next),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await runtime.inference.worker.runOne(
    member.organizationId,
    second.requestId,
  );
  expect(JSON.parse(start.mock.calls[1]![0].userPrompt)).toEqual([
    { role: "user", content: message().prompt },
    { role: "assistant", content: answer.text },
    { role: "user", content: "What happens next?" },
  ]);
  expect(await runtime.chat.store.list(owner)).toEqual([]);
  await expect(
    runtime.chat.store.get(owner, first.chatId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.chat.store.cancel(
      owner,
      randomUUID(),
      first.turnId,
      first.requestId,
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it("reserves daily budget atomically and does not refund uncertain provider work", async () => {
  await database.engine.query(
    "UPDATE cloud_ai_providers SET daily_token_budget=40000 WHERE id=$1",
    [providerId],
  );
  const first = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await expect(
    runtime.chat.store.submit(owner, randomUUID(), message()),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  const claim = (await runtime.inference.store.claim(
    member.organizationId,
    first.requestId,
  ))!;
  await runtime.inference.store.guard(
    member.organizationId,
    first.requestId,
    claim.executionId,
    { begin: true },
  );
  await database.engine.query(
    "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [first.requestId],
  );
  const interrupted = await runtime.chat.store.get(member, first.chatId);
  expect(interrupted.turns[0]?.state).toBe("unknown");
  await expect(
    runtime.chat.store.retry(member, randomUUID(), first.turnId, {
      revision: interrupted.turns[0]!.revision,
      providerId,
      model: "fixture-model",
    }),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(
    (await runtime.chat.store.budget(owner, providerId)).reservedTokens,
  ).toBeGreaterThan(1000);
  expect(start).not.toHaveBeenCalled();
});

it("enforces concurrency until uncertain requests expire and releases unsent cancellations", async () => {
  await database.engine.query(
    "UPDATE cloud_ai_providers SET max_concurrent_requests=1 WHERE id=$1",
    [providerId],
  );
  const first = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await expect(
    runtime.chat.store.submit(owner, randomUUID(), message()),
  ).rejects.toMatchObject({ code: "provider_busy" });
  await runtime.chat.store.cancel(
    member,
    randomUUID(),
    first.turnId,
    first.requestId,
  );
  expect(await runtime.chat.store.budget(owner, providerId)).toMatchObject({
    reservedTokens: 0,
    activeRequests: 0,
  });
  const next = await runtime.chat.store.submit(owner, randomUUID(), message());
  const claim = (await runtime.inference.store.claim(
    owner.organizationId,
    next.requestId,
  ))!;
  await runtime.inference.store.guard(
    owner.organizationId,
    next.requestId,
    claim.executionId,
    { begin: true },
  );
  await runtime.chat.store.cancel(
    owner,
    randomUUID(),
    next.turnId,
    next.requestId,
  );
  await runtime.inference.store.guard(
    owner.organizationId,
    next.requestId,
    claim.executionId,
  );
  expect(
    (await runtime.chat.store.get(owner, next.chatId)).turns[0]?.state,
  ).toBe("canceled");
  expect(
    (await runtime.chat.store.budget(owner, providerId)).activeRequests,
  ).toBe(1);
  await database.engine.query(
    "UPDATE cloud_inference_calls SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [next.requestId],
  );
  expect(
    (await runtime.chat.store.budget(owner, providerId)).activeRequests,
  ).toBe(0);
});

it("recovers a claim that never dispatched and fences its old execution token", async () => {
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  const first = (await runtime.inference.store.claim(
    member.organizationId,
    request.requestId,
  ))!;
  await database.engine.query(
    "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [request.requestId],
  );
  const second = (await runtime.inference.store.claim(
    member.organizationId,
    request.requestId,
  ))!;
  expect(second.executionId).not.toBe(first.executionId);
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        request.requestId,
        first.executionId,
        { begin: true },
      )
    ).allowed,
  ).toBe(false);
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        request.requestId,
        second.executionId,
        { begin: true },
      )
    ).allowed,
  ).toBe(true);
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        request.requestId,
        second.executionId,
        { begin: true },
      )
    ).allowed,
  ).toBe(false);
});

it("retries visibly once after a crash and ignores a late answer from the old request", async () => {
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  const old = (await runtime.inference.store.claim(
    member.organizationId,
    request.requestId,
  ))!;
  await runtime.inference.store.guard(
    member.organizationId,
    request.requestId,
    old.executionId,
    { begin: true },
  );
  await database.engine.query(
    "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [request.requestId],
  );
  await runtime.inference.store.recover();
  await runtime.inference.worker.runOne(
    member.organizationId,
    request.requestId,
  );
  expect(start).not.toHaveBeenCalled();
  const interrupted = (await runtime.chat.store.get(member, request.chatId))
    .turns[0]!;
  const retry = await runtime.chat.store.retry(
    member,
    randomUUID(),
    request.turnId,
    { revision: interrupted.revision, providerId, model: "fixture-model" },
  );
  expect(retry.turnId).toBe(request.turnId);
  expect(retry.requestId).not.toBe(request.requestId);
  await runtime.inference.worker.runOne(member.organizationId, retry.requestId);
  await runtime.inference.store.finish(
    member.organizationId,
    request.requestId,
    old.executionId,
    { state: "complete", answer: "Stale answer", tokens: 12, errorCode: null },
  );
  const detail = await runtime.chat.store.get(member, request.chatId);
  expect(detail.turns).toHaveLength(1);
  expect(detail.turns[0]?.answer).toBe(answer.text);
  expect(
    (await database.engine.query("SELECT id FROM cloud_inference_calls")).rows,
  ).toHaveLength(2);
});

it("stops work when membership or provider grants change", async () => {
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  const claim = (await runtime.inference.store.claim(
    member.organizationId,
    request.requestId,
  ))!;
  await runtime.inference.store.guard(
    member.organizationId,
    request.requestId,
    claim.executionId,
    { begin: true },
  );
  await runtime.administration.updateMember(
    owner,
    randomUUID(),
    member.userId,
    { revision: 1, role: "member", active: false },
  );
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        request.requestId,
        claim.executionId,
        { answer: "Private answer" },
      )
    ).allowed,
  ).toBe(false);
  await expect(
    runtime.chat.store.get(member, request.chatId),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await database.engine.query<{ answer: string; state: string }>(
        "SELECT answer,state FROM cloud_chat_turns WHERE id=$1",
        [request.turnId],
      )
    ).rows[0],
  ).toEqual({ answer: "", state: "canceled" });
});

it("refuses unknown tools and lets the model recover", async () => {
  start
    .mockResolvedValueOnce({
      ...answer,
      toolCalls: [{ id: "call", name: "execute_shell", arguments: {} }],
    })
    .mockResolvedValueOnce(answer);
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    request.requestId,
  );
  expect(start.mock.calls[1]![0].userPrompt).toContain(
    "Unknown tool execute_shell.",
  );
  const [turn] = (await runtime.chat.store.get(member, request.chatId)).turns;
  expect(turn).toMatchObject({ state: "complete", answer: answer.text });
  expect(turn!.steps).toEqual([
    {
      id: "call",
      tool: "execute_shell",
      label: "Unknown tool execute_shell",
      failed: true,
    },
  ]);
});

it.each(["oversize", "authentication"] as const)(
  "fails safely on %s without leaking provider errors",
  async (kind) => {
    start.mockImplementation(async () => {
      if (kind === "authentication")
        throw Object.assign(new Error("private-fixture-key is invalid"), {
          status: 401,
        });
      return { ...answer, text: "x".repeat(maximumInferenceAnswerBytes + 1) };
    });
    const request = await runtime.chat.store.submit(
      member,
      randomUUID(),
      message(),
    );
    await runtime.inference.worker.runOne(
      member.organizationId,
      request.requestId,
    );
    const detail = await runtime.chat.store.get(member, request.chatId);
    expect(detail.turns[0]).toMatchObject({
      state: "failed",
      errorCode:
        kind === "oversize" ? "output_limit" : "provider_authentication",
    });
    expect(JSON.stringify(detail)).not.toContain("private-fixture-key");
    expect(start).toHaveBeenCalledTimes(1);
  },
);

it("does not treat partial streamed usage as a final bill on cancellation", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finishLate!: (value: AgentModelTurn) => void;
  start.mockImplementation((params) => {
    params.onStreamEvent?.({ type: "usage", usage: { totalTokens: 1 } });
    markStarted();
    return new Promise((resolve) => {
      finishLate = resolve;
    });
  });
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  const running = runtime.inference.worker.runOne(
    member.organizationId,
    request.requestId,
  );
  await started;
  await runtime.chat.store.cancel(
    member,
    randomUUID(),
    request.turnId,
    request.requestId,
  );
  await runtime.inference.worker.close();
  await running;
  finishLate(answer);
  expect(
    (await runtime.chat.store.get(member, request.chatId)).turns[0]?.state,
  ).toBe("canceled");
  expect(await runtime.chat.store.budget(owner, providerId)).toMatchObject({
    usedTokens: 0,
  });
  expect(
    (await runtime.chat.store.budget(owner, providerId)).reservedTokens,
  ).toBeGreaterThan(256);
});

it("rechecks the budget day before dispatch and expires an unsent request without charging it", async () => {
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await database.engine.query(
    "UPDATE cloud_inference_calls SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [request.requestId],
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    request.requestId,
  );
  expect(start).not.toHaveBeenCalled();
  expect(
    (await runtime.chat.store.get(member, request.chatId)).turns[0]?.state,
  ).toBe("failed");
  expect(await runtime.chat.store.budget(owner, providerId)).toMatchObject({
    usedTokens: 0,
    reservedTokens: 0,
  });
  const next = await runtime.chat.store.submit(member, randomUUID(), message());
  await database.engine.query(
    "UPDATE cloud_inference_calls SET budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1 WHERE id=$1",
    [next.requestId],
  );
  await runtime.inference.worker.runOne(member.organizationId, next.requestId);
  expect(
    (await runtime.chat.store.get(member, next.chatId)).turns[0]?.state,
  ).toBe("complete");
  expect((await runtime.chat.store.budget(owner, providerId)).usedTokens).toBe(
    16,
  );
});

it("checks new-day capacity again at the network boundary", async () => {
  await database.engine.query(
    "UPDATE cloud_ai_providers SET daily_token_budget=40000 WHERE id=$1",
    [providerId],
  );
  const old = await runtime.chat.store.submit(member, randomUUID(), message());
  const claim = (await runtime.inference.store.claim(
    member.organizationId,
    old.requestId,
  ))!;
  await database.engine.query(
    "UPDATE cloud_inference_calls SET budget_day=(now() AT TIME ZONE 'UTC')::date-1 WHERE id=$1",
    [old.requestId],
  );
  await runtime.chat.store.submit(owner, randomUUID(), message());
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        old.requestId,
        claim.executionId,
        { begin: true },
      )
    ).allowed,
  ).toBe(false);
  expect(
    (await runtime.chat.store.get(member, old.chatId)).turns[0],
  ).toMatchObject({ state: "failed", errorCode: "budget_exceeded" });
  expect(start).not.toHaveBeenCalled();
});

it("keeps admitted work on harmless settings edits and revokes it on credential changes", async () => {
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  const claim = (await runtime.inference.store.claim(
    member.organizationId,
    request.requestId,
  ))!;
  const current = (await runtime.aiProviders.list(owner, true)).providers[0]!;
  const update = providerUpdateSchema
    .strip()
    .parse({ ...current, name: "Renamed", dailyTokenBudget: 300000 });
  await runtime.aiProviders.update(owner, randomUUID(), providerId, update);
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        request.requestId,
        claim.executionId,
      )
    ).allowed,
  ).toBe(true);
  await runtime.aiProviders.update(owner, randomUUID(), providerId, {
    ...update,
    revision: 2,
    apiKey: "rotated-key",
  });
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        request.requestId,
        claim.executionId,
      )
    ).allowed,
  ).toBe(false);
  expect(
    (await runtime.chat.store.get(member, request.chatId)).turns[0],
  ).toMatchObject({ state: "canceled", errorCode: "permission_changed" });
});

it("fences an expired request even when maintenance has a full earlier batch", async () => {
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  const claim = (await runtime.inference.store.claim(
    member.organizationId,
    request.requestId,
  ))!;
  await runtime.inference.store.guard(
    member.organizationId,
    request.requestId,
    claim.executionId,
    { begin: true },
  );
  await database.engine.query(
    `WITH ids AS (SELECT gen_random_uuid() AS id FROM generate_series(1,100)),
    chats AS (INSERT INTO cloud_chats (organization_id,id,user_id,title) SELECT $1,id,$2,'Earlier request' FROM ids RETURNING id),
    turns AS (INSERT INTO cloud_chat_turns (organization_id,id,chat_id,provider_id,model,sequence,prompt,state,request_id)
      SELECT $1,id,id,$3,'fixture-model',1,'Earlier request','running',id FROM chats RETURNING id)
    INSERT INTO cloud_inference_calls (organization_id,id,turn_id,actor_id,provider_id,provider_revision,model,user_prompt,system_prompt,reserved_tokens,max_output_tokens,budget_day,state,execution_id,request_started_at,lease_until,deadline_at,created_at)
    SELECT $1,id,id,$2,$3,1,'fixture-model','[]','System',100,64,(now() AT TIME ZONE 'UTC')::date,'running',gen_random_uuid(),clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute',clock_timestamp()-interval '2 minutes' FROM turns`,
    [member.organizationId, member.userId, providerId],
  );
  await database.engine.query(
    "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [request.requestId],
  );
  expect(
    (
      await runtime.inference.store.guard(
        member.organizationId,
        request.requestId,
        claim.executionId,
        { begin: true },
      )
    ).allowed,
  ).toBe(false);
  expect(
    (await runtime.chat.store.get(member, request.chatId)).turns[0]?.state,
  ).toBe("unknown");
  await runtime.inference.store.finish(
    member.organizationId,
    request.requestId,
    claim.executionId,
    { state: "complete", answer: "Late answer", tokens: 16, errorCode: null },
  );
  expect(
    (await runtime.chat.store.get(member, request.chatId)).turns[0]?.answer,
  ).toBe("");
});

it("does not report a storage failure as a provider failure or send a second model request", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const finish = vi
    .spyOn(runtime.inference.store, "finish")
    .mockRejectedValueOnce(new Error("Storage unavailable"));
  try {
    const request = await runtime.chat.store.submit(
      member,
      randomUUID(),
      message(),
    );
    await runtime.inference.worker.runOne(
      member.organizationId,
      request.requestId,
    );
    expect(finish).toHaveBeenCalledTimes(1);
    expect(
      (await runtime.chat.store.get(member, request.chatId)).turns[0]?.state,
    ).toBe("running");
    await database.engine.query(
      "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [request.requestId],
    );
    await runtime.inference.store.recover();
    expect(
      (await runtime.chat.store.get(member, request.chatId)).turns[0],
    ).toMatchObject({ state: "unknown", errorCode: "interrupted" });
    await runtime.inference.worker.runOne(
      member.organizationId,
      request.requestId,
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "Cloud inference processing failed",
      "Error",
    );
  } finally {
    finish.mockRestore();
    log.mockRestore();
  }
});

it("keeps an accepted but unsent request queued when the dispatcher shuts down", async () => {
  let preparing!: () => void;
  const prepared = new Promise<void>((resolve) => {
    preparing = resolve;
  });
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const resolveProvider = runtime.aiProviders.resolve.bind(runtime.aiProviders);
  const resolve = vi
    .spyOn(runtime.aiProviders, "resolve")
    .mockImplementation(async (...args) => {
      preparing();
      await pending;
      return resolveProvider(...args);
    });
  try {
    const request = await runtime.chat.store.submit(
      member,
      randomUUID(),
      message(),
    );
    const running = runtime.inference.worker.runOne(
      member.organizationId,
      request.requestId,
    );
    await prepared;
    const closing = runtime.inference.worker.close();
    resume();
    await Promise.all([closing, running]);
    expect(start).not.toHaveBeenCalled();
    expect(
      (await runtime.chat.store.get(member, request.chatId)).turns[0]?.state,
    ).toBe("queued");
  } finally {
    resolve.mockRestore();
  }
});

it("allows only one dispatcher instance to execute a reserved request", async () => {
  const other = createCloudRuntime(database, runtime.origin, {
    credentialsCipher: new SettingsCipher(key),
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => answer,
    }),
  });
  try {
    const request = await runtime.chat.store.submit(
      member,
      randomUUID(),
      message(),
    );
    await Promise.all([
      runtime.inference.worker.runOne(member.organizationId, request.requestId),
      other.inference.worker.runOne(member.organizationId, request.requestId),
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(
      (await runtime.chat.store.get(member, request.chatId)).turns[0]?.state,
    ).toBe("complete");
  } finally {
    await other.inference.worker.close();
  }
});

it("executes the stored instruction snapshot when dispatch occurs later", async () => {
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await database.engine.query(
    "UPDATE cloud_inference_calls SET system_prompt=$2 WHERE id=$1",
    [request.requestId, "Instruction snapshot from admission"],
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    request.requestId,
  );
  expect(start.mock.calls[0]![0].systemPrompt).toBe(
    "Instruction snapshot from admission",
  );
});

it("retries with an explicitly selected provider while preserving prior request attribution", async () => {
  start.mockRejectedValueOnce(
    Object.assign(new Error("Model unavailable"), { status: 404 }),
  );
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    request.requestId,
  );
  const failed = (await runtime.chat.store.get(member, request.chatId))
    .turns[0]!;
  const alternate = await runtime.aiProviders.create(owner, randomUUID(), {
    name: "Alternate",
    provider: "openai",
    region: null,
    models: ["alternate-model"],
    apiKey: "alternate-key",
    maxOutputTokens: 128,
    dailyTokenBudget: 200000,
    maxConcurrentRequests: 1,
  });
  const retry = await runtime.chat.store.retry(
    member,
    randomUUID(),
    request.turnId,
    {
      revision: failed.revision,
      providerId: alternate.id,
      model: "alternate-model",
    },
  );
  await runtime.inference.worker.runOne(member.organizationId, retry.requestId);
  expect(start.mock.calls[1]![0].model).toBe("alternate-model");
  const detail = await runtime.chat.store.get(member, request.chatId);
  expect(detail.turns).toHaveLength(1);
  expect(detail.turns[0]).toMatchObject({
    providerId: alternate.id,
    model: "alternate-model",
    state: "complete",
  });
  const previous = (
    await database.engine.query<{ provider_id: string }>(
      "SELECT provider_id FROM cloud_inference_calls WHERE id=$1",
      [request.requestId],
    )
  ).rows[0];
  expect(previous?.provider_id).toBe(providerId);
});

it("keeps the reservation when the provider omits a complete total-token receipt", async () => {
  start.mockResolvedValue({
    text: "Answer",
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 50 },
  });
  const request = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    request.requestId,
  );
  expect(
    (await runtime.chat.store.get(member, request.chatId)).turns[0]?.state,
  ).toBe("complete");
  const budget = await runtime.chat.store.budget(owner, providerId);
  expect(budget.usedTokens).toBe(0);
  expect(budget.reservedTokens).toBeGreaterThan(256);
  expect(budget.activeRequests).toBe(0);
});

it.each([
  [402, "provider_billing"],
  [403, "provider_access"],
  [404, "provider_model_unavailable"],
  [429, "provider_rate_limited"],
] as const)(
  "reports provider status %s without leaking error details",
  async (status, errorCode) => {
    start.mockRejectedValue(
      Object.assign(new Error("private-fixture-key must not appear"), {
        status,
      }),
    );
    const request = await runtime.chat.store.submit(
      member,
      randomUUID(),
      message(),
    );
    await runtime.inference.worker.runOne(
      member.organizationId,
      request.requestId,
    );
    const detail = await runtime.chat.store.get(member, request.chatId);
    expect(detail.turns[0]).toMatchObject({ state: "failed", errorCode });
    expect(JSON.stringify(detail)).not.toContain("private-fixture-key");
    expect(start).toHaveBeenCalledTimes(1);
  },
);

it("grounds answers in the workspace the user can access and keeps a focused issue", async () => {
  const scale = [
    { label: "1", points: 1 },
    { label: "3", points: 3 },
  ];
  const visible = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Product",
    key: "PRD",
    visibility: "organization",
    estimateScale: scale,
  });
  const hidden = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Finance",
    key: "FIN",
    visibility: "private",
    estimateScale: scale,
  });
  const project = await runtime.projects.create(owner, randomUUID(), {
    teamId: visible.id,
    name: "Checkout redesign",
    description: "Faster checkout",
  });
  const focus = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId: visible.id,
      projectId: project.id,
      title: "Payment retries lose the basket",
      description: "Retrying a declined payment empties the basket.",
      acceptanceCriteria: "The basket survives three retries.",
    }),
  );
  await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId: hidden.id,
      title: "Payment provider contract renewal",
      description: "Confidential payment terms.",
      acceptanceCriteria: "",
    }),
  );
  const hiddenProject = await runtime.projects.create(owner, randomUUID(), {
    teamId: hidden.id,
    name: "Treasury",
    description: "",
  });
  const child = await runtime.relations.createChild(
    owner,
    randomUUID(),
    focus.id,
    {
      parentRevision: (await runtime.planning.getIssue(owner, focus.id))
        .revision,
      issue: issueInputSchema.parse({
        teamId: visible.id,
        title: "Persist the basket",
      }),
    },
  );
  const submission = await runtime.chat.store.submit(member, randomUUID(), {
    ...message(),
    prompt: "Which payment issues are open and what blocks PRD-1?",
    context: [{ kind: "issue", id: focus.id }],
  });
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  const systemPrompt = start.mock.calls[0]![0].systemPrompt!;
  expect(systemPrompt).toContain(
    `## Issue [PRD-1](/cloud/issues/${focus.id}): Payment retries lose the basket`,
  );
  expect(systemPrompt).toContain("The basket survives three retries.");
  expect(systemPrompt).toContain(
    `- Sub-issue: [PRD-2](/cloud/issues/${child.id}) Persist the basket (Backlog)`,
  );
  expect(systemPrompt).toContain("Checkout redesign");
  expect(systemPrompt).not.toContain("contract renewal");
  expect(systemPrompt).not.toContain("Finance");
  const detail = await runtime.chat.store.get(member, submission.chatId);
  expect(detail.chat.context).toEqual([
    {
      kind: "issue",
      id: focus.id,
      label: "PRD-1",
      title: "Payment retries lose the basket",
      turnSequence: 1,
    },
  ]);
  await expect(
    runtime.chat.store.submit(member, randomUUID(), {
      ...message(),
      chatId: submission.chatId,
      revision: detail.chat.revision,
      prompt: "And the treasury?",
      context: [{ kind: "project", id: hiddenProject.id }],
    }),
  ).rejects.toMatchObject({ code: "context_unavailable" });
  const followUp = await runtime.chat.store.submit(member, randomUUID(), {
    ...message(),
    chatId: submission.chatId,
    revision: detail.chat.revision,
    prompt: "How is its project going?",
    context: [{ kind: "project", id: project.id }],
  });
  await runtime.inference.worker.runOne(
    member.organizationId,
    followUp.requestId,
  );
  const followUpPrompt = start.mock.calls[1]![0].systemPrompt!;
  expect(followUpPrompt).toContain(`## Issue [PRD-1]`);
  expect(followUpPrompt).toContain(
    `## Project [Checkout redesign](/cloud/projects/${project.id})`,
  );
  expect(
    (await runtime.chat.store.get(member, submission.chatId)).chat.context.map(
      (entry) => [entry.kind, entry.turnSequence],
    ),
  ).toEqual([
    ["issue", 1],
    ["project", 2],
  ]);
});

async function agentWorkspace() {
  const team = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Product",
    key: "PRD",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  const issue = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId: team.id,
      title: "Checkout loses the basket",
      description: "Retrying a payment empties the basket.",
    }),
  );
  return { team, issue };
}

function toolCall(name: string, args: Record<string, unknown>): AgentModelTurn {
  return {
    text: "",
    toolCalls: [{ id: `call-${name}-${randomUUID()}`, name, arguments: args }],
    usage: { totalTokens: 10 },
  };
}

it("runs workspace tools across rounds and records each step", async () => {
  await agentWorkspace();
  start
    .mockResolvedValueOnce(toolCall("search_issues", { query: "basket" }))
    .mockResolvedValueOnce(toolCall("get_issue", { issue: "prd-1" }))
    .mockResolvedValueOnce({
      text: "[PRD-1](/cloud/issues/x) loses the basket.",
      toolCalls: [],
      usage: { totalTokens: 12 },
    });
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  expect(start).toHaveBeenCalledTimes(3);
  const transcript = JSON.parse(start.mock.calls[2]![0].userPrompt) as {
    role: string;
    name?: string;
    content?: string;
  }[];
  expect(transcript.map((entry) => entry.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
    "tool",
  ]);
  expect(transcript[2]!.content).toContain("Checkout loses the basket");
  expect(transcript[4]!.content).toContain(
    "Retrying a payment empties the basket.",
  );
  const [turn] = (await runtime.chat.store.get(member, submission.chatId))
    .turns;
  expect(turn).toMatchObject({
    state: "complete",
    answer: "[PRD-1](/cloud/issues/x) loses the basket.",
    question: null,
    actions: [],
  });
  expect(turn!.steps.map((step) => [step.label, step.failed])).toEqual([
    ["Found 1 issue for “basket”", false],
    ["Read PRD-1", false],
  ]);
  expect(turn!.startedAt).not.toBeNull();
  expect(turn!.finishedAt).not.toBeNull();
  expect(await runtime.chat.store.budget(owner, providerId)).toMatchObject({
    usedTokens: 32,
    reservedTokens: 0,
  });
});

it("returns lookup failures to the model and stops after a clarifying question", async () => {
  await agentWorkspace();
  start
    .mockResolvedValueOnce(toolCall("get_issue", { issue: "FIN-9" }))
    .mockResolvedValueOnce(
      toolCall("ask_user", {
        question: "Which team do you mean?",
        options: ["Product", "Finance"],
      }),
    );
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]![0].userPrompt).toContain(
    "No accessible issue is named FIN-9.",
  );
  const detail = await runtime.chat.store.get(member, submission.chatId);
  expect(detail.turns[0]).toMatchObject({
    state: "complete",
    question: {
      text: "Which team do you mean?",
      options: ["Product", "Finance"],
    },
  });
  expect(detail.turns[0]!.steps.map((step) => step.failed)).toEqual([
    true,
    false,
  ]);
  const next = await runtime.chat.store.submit(member, randomUUID(), {
    ...message(),
    chatId: submission.chatId,
    revision: detail.chat.revision,
    prompt: "Product",
  });
  await runtime.inference.worker.runOne(member.organizationId, next.requestId);
  expect(JSON.parse(start.mock.calls[2]![0].userPrompt)).toEqual([
    { role: "user", content: message().prompt },
    {
      role: "assistant",
      content: "Which team do you mean?\nOptions: Product | Finance",
    },
    { role: "user", content: "Product" },
  ]);
});

it("applies confirmed proposals once with the user's permissions", async () => {
  const { team, issue } = await agentWorkspace();
  start
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          id: "propose-issue",
          name: "propose_issue",
          arguments: {
            team: "prd",
            title: "Persist the basket between retries",
            priority: "high",
            assignee: "member",
            estimate: "3",
            parent: "PRD-1",
          },
        },
        {
          id: "propose-update",
          name: "propose_issue_update",
          arguments: { issue: "PRD-1", priority: "urgent", status: "active" },
        },
        {
          id: "propose-comment",
          name: "propose_comment",
          arguments: { issue: "PRD-1", body: "Split into a sub-issue." },
        },
      ],
      usage: { totalTokens: 10 },
    })
    .mockResolvedValueOnce({
      text: "I proposed three changes.",
      toolCalls: [],
      usage: { totalTokens: 10 },
    });
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  const [turn] = (await runtime.chat.store.get(member, submission.chatId))
    .turns;
  expect(turn!.actions.map((action) => [action.kind, action.state])).toEqual([
    ["create_issue", "pending"],
    ["update_issue", "pending"],
    ["comment", "pending"],
  ]);
  expect(turn!.actions[0]!.fields).toContainEqual({
    label: "Parent",
    value: "PRD-1",
  });
  expect(
    (await runtime.planning.listIssueSummaries(member, { teamId: team.id }))
      .length,
  ).toBe(1);
  const [create, update, comment] = turn!.actions;
  await expect(
    runtime.chat.actions.apply(owner, turn!.id, create!.id),
  ).rejects.toMatchObject({ status: 404 });
  const created = await runtime.chat.actions.apply(
    member,
    turn!.id,
    create!.id,
  );
  expect(created).toMatchObject({
    state: "applied",
    result: { kind: "issue", label: "PRD-2" },
  });
  expect(
    await runtime.chat.actions.apply(member, turn!.id, create!.id),
  ).toEqual(created);
  const child = await runtime.planning.getIssue(member, created.result!.id);
  expect(child).toMatchObject({
    title: "Persist the basket between retries",
    priority: "high",
    assigneeId: member.userId,
    estimate: "3",
  });
  expect(
    (await runtime.relations.list(member, issue.id)).map((relation) => [
      relation.kind,
      relation.issue.identifier,
    ]),
  ).toEqual([["child", "PRD-2"]]);
  expect(
    await runtime.chat.actions.apply(member, turn!.id, update!.id),
  ).toMatchObject({ state: "applied" });
  expect(await runtime.planning.getIssue(member, issue.id)).toMatchObject({
    priority: "urgent",
    state: "active",
  });
  expect(
    await runtime.chat.actions.dismiss(member, turn!.id, comment!.id),
  ).toMatchObject({ state: "dismissed" });
  expect(
    await runtime.chat.actions.apply(member, turn!.id, comment!.id),
  ).toMatchObject({ state: "dismissed" });
  expect(await runtime.comments.list(member, issue.id, null)).toEqual([]);
});

it("marks a proposal failed when the issue changed after it was drafted", async () => {
  const { issue } = await agentWorkspace();
  start
    .mockResolvedValueOnce(
      toolCall("propose_issue_update", {
        issue: "PRD-1",
        title: "Keep the basket after retries",
      }),
    )
    .mockResolvedValueOnce({
      text: "Proposed.",
      toolCalls: [],
      usage: { totalTokens: 1 },
    });
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  const current = await runtime.planning.getIssue(member, issue.id);
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: issue.id, revision: current.revision }],
    changes: { title: "Changed elsewhere" },
  });
  const [turn] = (await runtime.chat.store.get(member, submission.chatId))
    .turns;
  expect(
    await runtime.chat.actions.apply(member, turn!.id, turn!.actions[0]!.id),
  ).toMatchObject({
    state: "failed",
    error:
      "This issue changed after the proposal. Ask Agent to propose the change again.",
  });
  expect((await runtime.planning.getIssue(member, issue.id)).title).toBe(
    "Changed elsewhere",
  );
});

it("forces a final answer without tools when the round limit is reached", async () => {
  await agentWorkspace();
  start.mockImplementation(async (params) =>
    params.tools.length
      ? toolCall("list_cycles", {})
      : { text: "Final answer", toolCalls: [], usage: { totalTokens: 1 } },
  );
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  expect(start).toHaveBeenCalledTimes(8);
  expect(start.mock.calls[7]![0].tools).toEqual([]);
  expect(start.mock.calls[7]![0].userPrompt).toContain(
    "The tool limit for this answer is reached.",
  );
  const [turn] = (await runtime.chat.store.get(member, submission.chatId))
    .turns;
  expect(turn).toMatchObject({ state: "complete", answer: "Final answer" });
  expect(turn!.steps).toHaveLength(7);
});

it("renames and archives a private conversation", async () => {
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  const { chat } = await runtime.chat.store.get(member, submission.chatId);
  await expect(
    runtime.chat.store.update(owner, randomUUID(), chat.id, {
      revision: chat.revision,
      title: "Taken",
    }),
  ).rejects.toMatchObject({ status: 404 });
  const renamed = await runtime.chat.store.update(
    member,
    randomUUID(),
    chat.id,
    { revision: chat.revision, title: "Cycle questions" },
  );
  expect((await runtime.chat.store.list(member))[0]).toMatchObject({
    id: chat.id,
    title: "Cycle questions",
  });
  await expect(
    runtime.chat.store.update(member, randomUUID(), chat.id, {
      revision: chat.revision,
      archived: true,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await runtime.chat.store.update(member, randomUUID(), chat.id, {
    revision: renamed.revision,
    archived: true,
  });
  expect(await runtime.chat.store.list(member)).toEqual([]);
  expect((await runtime.chat.store.get(member, chat.id)).chat.title).toBe(
    "Cycle questions",
  );
});

it("posts a confirmed project status update drafted by the agent", async () => {
  const { team } = await agentWorkspace();
  const project = await runtime.projects.create(owner, randomUUID(), {
    teamId: team.id,
    name: "Checkout",
    description: "",
  });
  start
    .mockResolvedValueOnce(
      toolCall("propose_project_update", {
        project: "checkout",
        health: "at_risk",
        body: "Payment retries are still flaky.",
      }),
    )
    .mockResolvedValueOnce({
      text: "Drafted.",
      toolCalls: [],
      usage: { totalTokens: 1 },
    });
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  const [turn] = (await runtime.chat.store.get(member, submission.chatId))
    .turns;
  expect(turn!.actions[0]).toMatchObject({
    kind: "project_update",
    projectId: project.id,
    fields: [
      { label: "Health", value: "At risk" },
      { label: "Update", value: "Payment retries are still flaky." },
    ],
  });
  expect(await runtime.projectUpdates.list(member, project.id)).toEqual([]);
  expect(
    await runtime.chat.actions.apply(member, turn!.id, turn!.actions[0]!.id),
  ).toMatchObject({
    state: "applied",
    result: { kind: "project", id: project.id, label: "Checkout" },
  });
  expect(await runtime.projectUpdates.list(member, project.id)).toMatchObject([
    {
      health: "at_risk",
      author: "member",
      body: "Payment retries are still flaky.",
    },
  ]);
});

it("settles an issue in triage as a confirmed duplicate", async () => {
  const { team, issue: original } = await agentWorkspace();
  const workflow = await runtime.workflows.get(owner, team.id);
  const triageId = randomUUID();
  const definition = {
    revision: workflow.revision,
    defaultStatusId: workflow.defaultStatusId,
    statuses: [
      {
        id: triageId,
        name: "Triage",
        category: "triage" as const,
        archived: false,
      },
      ...workflow.statuses.map(({ revision: _, ...status }) => status),
    ],
  };
  await runtime.workflows.update(owner, randomUUID(), team.id, {
    definition,
    impactDigest: (await runtime.workflows.preview(owner, team.id, definition))
      .digest,
  });
  const reported = await runtime.planning.createIssue(
    member,
    randomUUID(),
    issueInputSchema.parse({
      teamId: team.id,
      title: "Basket is empty after payment retry",
      status: { id: triageId, revision: 1 },
    }),
  );
  start
    .mockResolvedValueOnce(
      toolCall("propose_triage", { issue: "PRD-1", decision: "accept" }),
    )
    .mockResolvedValueOnce(
      toolCall("propose_triage", {
        issue: "prd-2",
        decision: "duplicate",
        duplicateOf: "PRD-1",
      }),
    )
    .mockResolvedValueOnce({
      text: "PRD-2 duplicates PRD-1.",
      toolCalls: [],
      usage: { totalTokens: 1 },
    });
  const submission = await runtime.chat.store.submit(
    member,
    randomUUID(),
    message(),
  );
  await runtime.inference.worker.runOne(
    member.organizationId,
    submission.requestId,
  );
  const [turn] = (await runtime.chat.store.get(member, submission.chatId))
    .turns;
  expect(turn!.steps.map((step) => step.failed)).toEqual([true, false]);
  expect(turn!.actions).toHaveLength(1);
  expect(turn!.actions[0]).toMatchObject({
    kind: "triage",
    issueId: reported.id,
    fields: [
      {
        label: "Duplicate of",
        value: "PRD-1 Checkout loses the basket",
      },
    ],
    decision: { decision: "duplicate", duplicateOfId: original.id },
  });
  expect((await runtime.planning.getIssue(member, reported.id)).state).toBe(
    "triage",
  );
  expect(
    await runtime.chat.actions.apply(member, turn!.id, turn!.actions[0]!.id),
  ).toMatchObject({
    state: "applied",
    result: { kind: "issue", id: reported.id, label: "PRD-2" },
  });
  expect((await runtime.planning.getIssue(member, reported.id)).state).toBe(
    "canceled",
  );
  expect(
    (await runtime.relations.list(member, reported.id)).map(
      (relation) => relation.kind,
    ),
  ).toEqual(["duplicate_of"]);
});
