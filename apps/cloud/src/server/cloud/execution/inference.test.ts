import { randomUUID } from "node:crypto";
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
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  defaultEstimateScale,
  issueInputSchema,
} from "../../../lib/cloud-contract";
import type { TaskInferenceInput } from "@machdoch/fleet-protocol/cloud-inference";
import { taskInferenceInputSchema } from "@machdoch/fleet-protocol/cloud-inference";
import { taskAgentTools } from "@machdoch/fleet-protocol/cloud-agent-tools";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let actor: CloudActor;
let worker: { id: string; token: string };
let providerId: string;
let profileId: string;
let input: TaskInferenceInput;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;
const commit = "a".repeat(40);
const output: AgentModelTurn = {
  text: "",
  toolCalls: [
    { id: "tool-1", name: "read_file", arguments: { path: "package.json" } },
  ],
  usage: { totalTokens: 32 },
};

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 30_000);
afterAll(async () => {
  await database?.close();
});
afterEach(async () => {
  await runtime?.inference.worker.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  actor = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES ($1,'Organization')",
    [actor.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES ($1,'owner@example.test','Owner','test')",
    [actor.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [actor.organizationId, actor.userId],
  );
  start = vi.fn(async () => output);
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 9)),
    modelAdapterFactory: async (connection, tools) => {
      expect(connection.apiKey).toBe("server-only-credential");
      expect(tools.map((tool) => tool.name)).toEqual(
        input.tools.map((tool) => tool.name),
      );
      return {
        startTurn: start,
        continueTurn: async () => {
          throw new Error("Unexpected continuation");
        },
      };
    },
  });
  const team = await runtime.planning.createTeam(actor, randomUUID(), {
    name: "Team",
    key: "TM",
    visibility: "organization",
    estimateScale: defaultEstimateScale,
  });
  const project = await runtime.projects.create(actor, randomUUID(), {
    teamId: team.id,
    name: "Project",
    description: "",
  });
  providerId = (
    await runtime.aiProviders.create(actor, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["test-model"],
      apiKey: "server-only-credential",
      maxOutputTokens: 256,
      dailyTokenBudget: 200000,
      maxConcurrentRequests: 4,
    })
  ).id;
  profileId = (
    await runtime.execution.profiles.create(actor, randomUUID(), {
      projectId: project.id,
      name: "Cloud",
      target: "cloud",
      repository: "https://github.com/example/project",
      baseCommit: commit,
      providerId,
      model: "test-model",
      maxDurationSeconds: 3600,
      maxTokens: 10000,
      requiredChecks: [
        { name: "unit", command: "node --test", timeoutSeconds: 60 },
      ],
    })
  ).id;
  const issue = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId: team.id,
      projectId: project.id,
      title: "Fix reconnect",
      acceptanceCriteria: "No duplicate commands",
    }),
  );
  await runtime.execution.runs.create(actor, randomUUID(), {
    profileId,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  worker = await runtime.execution.workers.register(actor, profileId, "Worker");
  const { claim } = await runtime.execution.leases.claim(
    worker.token,
    randomUUID(),
  );
  input = {
    runId: claim!.runId,
    attemptId: claim!.attemptId,
    epoch: claim!.epoch,
    requestId: randomUUID(),
    runtimePrompt: "",
    modelOptions: {},
    tools: taskAgentTools,
    context: "Inspect package.json",
  };
  await runtime.execution.leases.accept(worker.token, {
    runId: input.runId,
    attemptId: input.attemptId,
    epoch: input.epoch,
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm",
  });
});

function read() {
  const { context: _, ...identity } = input;
  return runtime.execution.inference.get(worker.token, identity);
}
async function stored() {
  return (
    await database.engine.query<{
      state: string;
      response: unknown;
      actual_tokens: number | null;
      error_code: string | null;
    }>(
      "SELECT state,response,actual_tokens,error_code FROM cloud_inference_calls WHERE id=$1",
      [input.requestId],
    )
  ).rows[0]!;
}

it("persists a duplicate-safe request and delivers validated tools without revealing credentials", async () => {
  const receipts = await Promise.all([
    runtime.execution.inference.submit(worker.token, input),
    runtime.execution.inference.submit(worker.token, input),
  ]);
  expect(receipts[0]).toEqual(receipts[1]);
  await expect(
    runtime.execution.inference.submit(worker.token, {
      ...input,
      context: "Changed",
    }),
  ).rejects.toMatchObject({ code: "request_conflict" });
  await Promise.all([
    runtime.inference.worker.runOne(actor.organizationId, input.requestId),
    runtime.inference.worker.runOne(actor.organizationId, input.requestId),
  ]);
  expect(start).toHaveBeenCalledTimes(1);
  const request = start.mock.calls[0]![0];
  expect(request).toMatchObject({
    parallelAgentMode: "disabled",
    maxOutputTokens: 256,
    maxRequestAttempts: 1,
    storeResponses: false,
  });
  expect(request.tools.map((tool) => tool.name)).toEqual([
    "read_file",
    "write_file",
    "list_files",
    "shell",
  ]);
  expect(request.userPrompt).toContain("No duplicate commands");
  const receipt = await read();
  expect(receipt).toMatchObject({
    state: "complete",
    response: { text: "", toolCalls: output.toolCalls },
    chargedTokens: 32,
  });
  expect(JSON.stringify(receipt)).not.toContain("server-only-credential");
  expect(await runtime.execution.inference.submit(worker.token, input)).toEqual(
    receipt,
  );
  const another = createCloudRuntime(database, "https://cloud.example.test");
  try {
    expect(
      await another.execution.inference.submit(worker.token, input),
    ).toEqual(receipt);
  } finally {
    await another.inference.worker.close();
  }
  expect(await runtime.chat.store.list(actor)).toEqual([]);
  expect(await runtime.chat.store.budget(actor, providerId)).toMatchObject({
    usedTokens: 32,
    reservedTokens: 0,
    activeRequests: 0,
  });
});

it("shares admission slots and token budgets with conversational chat", async () => {
  await runtime.execution.inference.submit(worker.token, input);
  for (let index = 0; index < 3; index++)
    await runtime.chat.store.submit(actor, randomUUID(), {
      chatId: null,
      revision: null,
      providerId,
      model: "test-model",
      prompt: "Question",
    });
  await expect(
    runtime.chat.store.submit(actor, randomUUID(), {
      chatId: null,
      revision: null,
      providerId,
      model: "test-model",
      prompt: "Too many",
    }),
  ).rejects.toMatchObject({ code: "provider_busy" });
  await expect(
    runtime.execution.inference.submit(worker.token, {
      ...input,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "inference_active" });
  expect(
    (await runtime.chat.store.budget(actor, providerId)).activeRequests,
  ).toBe(4);
});

it("meters a full runtime catalog and preserves pinned task authority", async () => {
  await database.engine.query(
    "UPDATE cloud_runs SET manifest=jsonb_set(manifest,'{profile,maxTokens}','200000'::jsonb) WHERE id=$1",
    [input.runId],
  );
  input = taskInferenceInputSchema.parse({
    ...input,
    runtimePrompt: "Runtime instructions. ".repeat(500),
    modelOptions: { reasoning: "high", toolChoice: "required" },
    tools: [
      ...taskAgentTools,
      ...Array.from({ length: 104 }, (_, index) => ({
        name: `runtime_tool_${index}`,
        description: "Tool description. ".repeat(45),
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      })),
    ],
  });
  const receipt = await runtime.execution.inference.submit(worker.token, input);
  expect(receipt.chargedTokens).toBeGreaterThan(64 * 1024);
  await expect(
    runtime.execution.inference.submit(worker.token, {
      ...input,
      runtimePrompt: "Changed guidance",
    }),
  ).rejects.toMatchObject({ code: "request_conflict" });
  await runtime.inference.worker.runOne(actor.organizationId, input.requestId);
  expect(start).toHaveBeenCalledTimes(1);
  const request = start.mock.calls[0]![0];
  expect(request.tools).toEqual(input.tools);
  expect(request).toMatchObject({ reasoning: "high", toolChoice: "required" });
  expect(request.systemPrompt).toMatch(
    /^You are the implementation agent for machdoch.cloud\./,
  );
  expect(request.systemPrompt).toContain(input.runtimePrompt);
  expect(request.userPrompt).toContain("No duplicate commands");
  expect(await read()).toMatchObject({ state: "complete", chargedTokens: 32 });
  expect(await runtime.chat.store.budget(actor, providerId)).toMatchObject({
    usedTokens: 32,
    reservedTokens: 0,
  });
});

it("rejects duplicate tool names and excessive schema depth before admission", () => {
  expect(
    taskInferenceInputSchema.safeParse({
      ...input,
      tools: [taskAgentTools[0], taskAgentTools[0]],
    }).success,
  ).toBe(false);
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < 40; index++)
    schema = { properties: { child: schema } };
  expect(
    taskInferenceInputSchema.safeParse({
      ...input,
      tools: [{ name: "deep", description: "", inputSchema: schema }],
    }).success,
  ).toBe(false);
});

it("meters structured auxiliary requests without granting tools", async () => {
  const format = {
    name: "review",
    strict: true,
    schema: {
      type: "object",
      properties: { outcome: { type: "string" } },
      required: ["outcome"],
      additionalProperties: false,
    },
  };
  input = {
    ...input,
    tools: [],
    modelOptions: { structuredOutput: format },
    runtimePrompt: "Review the task result.",
  };
  start.mockResolvedValueOnce({
    text: '{"outcome":"success"}',
    toolCalls: [],
    usage: { totalTokens: 24 },
  });
  await runtime.execution.inference.submit(worker.token, input);
  await runtime.inference.worker.runOne(actor.organizationId, input.requestId);
  expect(start.mock.calls[0]![0]).toMatchObject({
    tools: [],
    structuredOutput: format,
  });
  expect(await read()).toMatchObject({
    state: "complete",
    chargedTokens: 24,
    response: { text: '{"outcome":"success"}', toolCalls: [] },
  });
  await expect(
    runtime.execution.inference.submit(worker.token, {
      ...input,
      requestId: randomUUID(),
      modelOptions: { toolChoice: "required" },
    }),
  ).rejects.toMatchObject({ code: "tool_selection" });
});

it("rejects foreign runners, stale epochs, and caller-supplied providers or tool definitions", async () => {
  const stranger = await runtime.execution.workers.register(
    actor,
    profileId,
    "Other worker",
  );
  await expect(
    runtime.execution.inference.submit(stranger.token, input),
  ).rejects.toMatchObject({ code: "attempt_unavailable" });
  await expect(
    runtime.execution.inference.submit(worker.token, {
      ...input,
      epoch: input.epoch + 1,
    }),
  ).rejects.toMatchObject({ code: "attempt_unavailable" });
  expect(
    taskInferenceInputSchema.safeParse({
      ...input,
      tools: [{ name: "bad", inputSchema: null }],
    }).success,
  ).toBe(false);
  expect(
    taskInferenceInputSchema.safeParse({ ...input, providerId: randomUUID() })
      .success,
  ).toBe(false);
  await database.engine.query(
    "UPDATE cloud_run_attempts SET state='preparing' WHERE id=$1",
    [input.attemptId],
  );
  await expect(
    runtime.execution.inference.submit(worker.token, input),
  ).rejects.toMatchObject({ code: "attempt_stopped" });
});

it.each(["lease", "worker", "membership", "profile", "provider", "team"])(
  "rechecks %s authority between claiming and dispatch",
  async (kind) => {
    await runtime.execution.inference.submit(worker.token, input);
    const claim = (await runtime.inference.store.claim(
      actor.organizationId,
      input.requestId,
    ))!;
    if (kind === "lease")
      await database.engine.query(
        "UPDATE cloud_run_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [input.attemptId],
      );
    if (kind === "worker")
      await database.engine.query(
        "UPDATE cloud_execution_workers SET enabled=false WHERE id=$1",
        [worker.id],
      );
    if (kind === "membership")
      await database.engine.query(
        "UPDATE cloud_memberships SET active=false WHERE user_id=$1",
        [actor.userId],
      );
    if (kind === "profile")
      await database.engine.query(
        "UPDATE cloud_execution_profiles SET revision=revision+1 WHERE id=$1",
        [profileId],
      );
    if (kind === "provider")
      await database.engine.query(
        "UPDATE cloud_ai_providers SET inference_revision=inference_revision+1 WHERE id=$1",
        [providerId],
      );
    if (kind === "team") {
      await database.engine.query(
        "UPDATE cloud_memberships SET role='member' WHERE user_id=$1",
        [actor.userId],
      );
      await database.engine.exec("UPDATE cloud_teams SET visibility='private'");
      await database.engine.query(
        "DELETE FROM cloud_team_memberships WHERE user_id=$1",
        [actor.userId],
      );
    }
    expect(
      (
        await runtime.inference.store.guard(
          actor.organizationId,
          input.requestId,
          claim.executionId,
          { begin: true },
        )
      ).allowed,
    ).toBe(false);
    expect(await stored()).toMatchObject({
      state: "canceled",
      actual_tokens: 0,
      response: null,
    });
    expect(start).not.toHaveBeenCalled();
  },
);

it("retains unknown charges after a dispatched crash without replaying the provider request", async () => {
  const reservation = await runtime.execution.inference.submit(
    worker.token,
    input,
  );
  const claim = (await runtime.inference.store.claim(
    actor.organizationId,
    input.requestId,
  ))!;
  await runtime.inference.store.guard(
    actor.organizationId,
    input.requestId,
    claim.executionId,
    { begin: true },
  );
  await database.engine.query(
    "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [input.requestId],
  );
  await runtime.inference.store.recover();
  expect(await read()).toMatchObject({
    state: "unknown",
    response: null,
    chargedTokens: reservation.chargedTokens,
  });
  await runtime.inference.worker.runOne(actor.organizationId, input.requestId);
  expect(start).not.toHaveBeenCalled();
  expect(await runtime.chat.store.budget(actor, providerId)).toMatchObject({
    reservedTokens: reservation.chargedTokens,
    activeRequests: 1,
  });
  await runtime.inference.store.finish(
    actor.organizationId,
    input.requestId,
    claim.executionId,
    {
      state: "complete",
      response: { text: "Late", toolCalls: output.toolCalls },
      tokens: 32,
      errorCode: null,
    },
  );
  expect(await read()).toMatchObject({
    state: "unknown",
    response: null,
    chargedTokens: 32,
  });
});

it("recovers an unsent request with a new execution identity and no duplicate charge", async () => {
  const receipt = await runtime.execution.inference.submit(worker.token, input);
  const first = (await runtime.inference.store.claim(
    actor.organizationId,
    input.requestId,
  ))!;
  await database.engine.query(
    "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [input.requestId],
  );
  await runtime.inference.store.recover();
  expect(await read()).toEqual(receipt);
  await runtime.inference.worker.runOne(actor.organizationId, input.requestId);
  expect(start).toHaveBeenCalledTimes(1);
  expect(
    (
      await runtime.inference.store.guard(
        actor.organizationId,
        input.requestId,
        first.executionId,
        { begin: true },
      )
    ).allowed,
  ).toBe(false);
});

it("fences a late tool response after cancellation while retaining measured usage", async () => {
  let release!: (value: AgentModelTurn) => void;
  start.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await runtime.execution.inference.submit(worker.token, input);
  const pending = runtime.inference.worker.runOne(
    actor.organizationId,
    input.requestId,
  );
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  const run = await runtime.execution.runs.get(actor, input.runId);
  await runtime.execution.runs.cancel(
    actor,
    randomUUID(),
    run.id,
    run.revision,
  );
  release(output);
  await pending;
  expect(await stored()).toMatchObject({
    state: "canceled",
    response: null,
    actual_tokens: 32,
  });
  await expect(read()).rejects.toMatchObject({ code: "attempt_stopped" });
});

it.each([
  {
    name: "unknown tools",
    response: {
      ...output,
      toolCalls: [{ id: "1", name: "publish", arguments: {} }],
    },
    code: "unexpected_tools",
  },
  {
    name: "invalid arguments",
    response: {
      ...output,
      toolCalls: [
        {
          id: "1",
          name: "shell",
          arguments: { command: "true", timeoutMs: -1 },
        },
      ],
    },
    code: "invalid_tools",
  },
  {
    name: "duplicate IDs",
    response: {
      ...output,
      toolCalls: [output.toolCalls[0]!, output.toolCalls[0]!],
    },
    code: "invalid_tools",
  },
  {
    name: "incomplete responses",
    response: { ...output, stopReason: "incomplete" },
    code: "response_incomplete",
  },
])(
  "rejects $name without delivering executable output",
  async ({ response, code }) => {
    start.mockResolvedValue(response);
    await runtime.execution.inference.submit(worker.token, input);
    await runtime.inference.worker.runOne(
      actor.organizationId,
      input.requestId,
    );
    expect(await read()).toMatchObject({
      state: "failed",
      response: null,
      errorCode: code,
      chargedTokens: 32,
    });
  },
);

it("enforces the task budget using provider usage even when the worker underreports tokens", async () => {
  start.mockResolvedValue({ ...output, usage: { totalTokens: 20001 } });
  await runtime.execution.inference.submit(worker.token, input);
  await runtime.inference.worker.runOne(actor.organizationId, input.requestId);
  expect(await read()).toMatchObject({
    state: "failed",
    response: null,
    errorCode: "task_budget_exceeded",
  });
  await expect(
    runtime.execution.inference.submit(worker.token, {
      ...input,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "task_budget_exceeded" });
  await runtime.execution.leases.progress(worker.token, {
    runId: input.runId,
    attemptId: input.attemptId,
    epoch: input.epoch,
    state: "validating",
  });
  const run = await runtime.execution.runs.get(actor, input.runId);
  await expect(
    runtime.execution.leases.finish(worker.token, {
      runId: input.runId,
      attemptId: input.attemptId,
      epoch: input.epoch,
      outcome: "succeeded",
      summary: "Done",
      stopped: true,
      inputDigest: run.inputDigest,
      candidateCommit: commit,
      tokensUsed: 0,
      checks: [
        {
          name: "unit",
          passed: true,
          candidateCommit: commit,
          evidenceDigest: "b".repeat(64),
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
});

it("rechecks a reduced daily budget on the same day before dispatch", async () => {
  await runtime.execution.inference.submit(worker.token, input);
  await database.engine.query(
    "UPDATE cloud_ai_providers SET daily_token_budget=1000 WHERE id=$1",
    [providerId],
  );
  await runtime.inference.worker.runOne(actor.organizationId, input.requestId);
  expect(start).not.toHaveBeenCalled();
  expect(await read()).toMatchObject({
    state: "failed",
    chargedTokens: 0,
    errorCode: "budget_exceeded",
  });
});

it("rejects oversized UTF-8 context before reserving capacity", async () => {
  await expect(
    runtime.execution.inference.submit(worker.token, {
      ...input,
      context: "😀".repeat(18000),
    }),
  ).rejects.toMatchObject({ code: "context_limit" });
  expect(await runtime.chat.store.budget(actor, providerId)).toMatchObject({
    usedTokens: 0,
    reservedTokens: 0,
    activeRequests: 0,
  });
});
