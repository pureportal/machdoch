import { taskAgentTools } from "@machdoch/fleet-protocol/cloud-agent-tools";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-task-inference-fixture.ts",
});
const page = await fixture.ownerContext.newPage();
const runnerContext = await fixture.createContext();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
const commit = "a".repeat(40);
let worker;
let heartbeat;
let claim;
const identity = () => ({
  runId: claim.runId,
  attemptId: claim.attemptId,
  epoch: claim.epoch,
});
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function runner(path, body, status = 200, token = worker.token) {
  const response = await runnerContext.request.post(
    `${fixture.origin}/api/v1/runner/${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: body,
    },
  );
  assert.equal(response.status(), status, await response.text());
  return response.json();
}
async function stored(requestId) {
  return (
    await fixture.database.query(
      "SELECT state,response,actual_tokens,reserved_tokens,error_code FROM cloud_inference_calls WHERE id=$1",
      [requestId],
    )
  ).rows[0];
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Inference",
    key: "AI",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Inference project",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
    { name: "Task provider", models: ["gpt-5.5"] },
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Task inference",
    target: "cloud",
    repository: "https://github.com/example/project",
    baseCommit: commit,
    providerId: provider.id,
    model: "gpt-5.5",
    maxDurationSeconds: 600,
    maxTokens: 100000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Broker verification",
  });
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Verify task inference",
    acceptanceCriteria: "Budgeted requests and cancellation",
  });
  await api("runs", "POST", {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  claim = (await runner("claims", { claimId: randomUUID() })).claim;
  await runner("accept", {
    ...identity(),
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm",
  });
  const heartbeatErrors = [];
  heartbeat = setInterval(
    () =>
      void runner("heartbeat", identity()).catch((error) =>
        heartbeatErrors.push(error.message),
      ),
    15000,
  );
  const input = {
    ...identity(),
    requestId: randomUUID(),
    runtimePrompt: "",
    modelOptions: {},
    tools: taskAgentTools,
    context: "Inspect package.json",
  };
  const duplicates = await Promise.all([
    runner("inference", input),
    runner("inference", input),
  ]);
  assert.equal(duplicates[0].requestId, duplicates[1].requestId);
  await assertEventually(
    async () => (await stored(input.requestId))?.state === "complete",
  );
  const receipt = await runner("inference/result", {
    ...identity(),
    requestId: input.requestId,
  });
  assert.deepEqual(
    receipt.response.toolCalls.map(({ name, arguments: args }) => ({
      name,
      arguments: args,
    })),
    [{ name: "read_file", arguments: { path: "package.json" } }],
  );
  assert.equal(receipt.chargedTokens, 32);
  const requests = (
    await fixture.database.query(
      "SELECT body FROM verification_task_requests WHERE context=$1",
      [input.context],
    )
  ).rows;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.deepEqual(
    requests[0].body.tools.map((tool) => tool.name),
    ["read_file", "write_file", "list_files", "shell"],
  );
  assert.equal(requests[0].body.max_output_tokens, 512);
  assert.equal(JSON.stringify(receipt).includes("apiKey"), false);
  await runner("inference", { ...input, context: "Changed request" }, 409);
  const foreign = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Other runner",
  });
  await runner(
    "inference/result",
    { ...identity(), requestId: input.requestId },
    404,
    foreign.token,
  );
  passed(
    "Concurrent duplicate requests dispatch once through the shared SDK and return scoped tool receipts",
  );

  await page.goto(`${fixture.origin}/cloud/tasks/${claim.runId}`);
  await assertEventually(
    async () =>
      (await page
        .locator(".cloud-task-properties > div")
        .filter({ has: page.getByText("Tokens used", { exact: true }) })
        .locator("dd")
        .textContent()) === "32",
  );
  assert.deepEqual((await api(`runs/${claim.runId}`)).usage, {
    usedTokens: 32,
    reservedTokens: 0,
    requests: 1,
  });
  passed("Task details show measured provider usage");

  const fullRuntime = {
    ...input,
    requestId: randomUUID(),
    context: "Use the complete runtime catalog",
    runtimePrompt: "Runtime guidance. ".repeat(20),
    modelOptions: { reasoning: "high", toolChoice: "required" },
    tools: [
      ...taskAgentTools,
      ...Array.from({ length: 104 }, (_, index) => ({
        name: `runtime_tool_${index}`,
        description: "Runtime tool. ".repeat(45),
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      })),
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(fullRuntime)) > 64 * 1024);
  await runner("inference", fullRuntime);
  await assertEventually(async () =>
    ["complete", "failed", "unknown"].includes(
      (await stored(fullRuntime.requestId))?.state,
    ),
  );
  assert.equal(
    (await stored(fullRuntime.requestId)).state,
    "complete",
    (await stored(fullRuntime.requestId)).error_code,
  );
  const fullReceipt = await runner("inference/result", {
    ...identity(),
    requestId: fullRuntime.requestId,
  });
  assert.equal(fullReceipt.chargedTokens, 32);
  const fullRequests = (
    await fixture.database.query(
      "SELECT body FROM verification_task_requests WHERE context=$1",
      [fullRuntime.context],
    )
  ).rows;
  assert.equal(fullRequests.length, 1);
  assert.equal(fullRequests[0].body.tools.length, 108);
  assert.equal(fullRequests[0].body.tool_choice, "required");
  assert.equal(fullRequests[0].body.reasoning.effort, "high");
  assert.ok(
    fullRequests[0].body.instructions.includes(fullRuntime.runtimePrompt),
  );
  await assertEventually(
    async () => (await api(`runs/${claim.runId}`)).usage.usedTokens === 64,
  );
  passed(
    "A full runtime catalog crosses the bounded HTTP broker and retains measured accounting",
  );

  const auxiliary = {
    ...input,
    requestId: randomUUID(),
    context: "Review the completed task",
    runtimePrompt: "Return the structured task review.",
    tools: [],
    modelOptions: {
      structuredOutput: {
        name: "task_review",
        strict: true,
        schema: {
          type: "object",
          properties: { outcome: { type: "string" } },
          required: ["outcome"],
          additionalProperties: false,
        },
      },
    },
  };
  await runner("inference", auxiliary);
  await assertEventually(async () =>
    ["complete", "failed", "unknown"].includes(
      (await stored(auxiliary.requestId))?.state,
    ),
  );
  const auxiliaryReceipt = await runner("inference/result", {
    ...identity(),
    requestId: auxiliary.requestId,
  });
  assert.equal(auxiliaryReceipt.state, "complete", auxiliaryReceipt.errorCode);
  assert.deepEqual(auxiliaryReceipt.response, {
    text: '{"outcome":"success"}',
    toolCalls: [],
  });
  const auxiliaryBody = (
    await fixture.database.query(
      "SELECT body FROM verification_task_requests WHERE context=$1",
      [auxiliary.context],
    )
  ).rows[0].body;
  assert.equal(auxiliaryBody.text.format.name, "task_review");
  assert.deepEqual(auxiliaryBody.tools, []);
  passed(
    "Auxiliary reasoning uses a structured response without tools and shares task accounting",
  );

  const held = {
    ...input,
    requestId: randomUUID(),
    context: "Hold for cancellation",
  };
  const pending = await runner("inference", held);
  await assertEventually(
    async () =>
      (
        await fixture.database.query(
          "SELECT state FROM verification_task_requests WHERE context=$1",
          [held.context],
        )
      ).rows[0]?.state === "held",
  );
  await page.getByText("Tokens reserved", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "task-inference-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel task", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await assertEventually(
    async () => (await stored(held.requestId)).state === "canceled",
  );
  const canceled = await stored(held.requestId);
  assert.equal(canceled.response, null);
  assert.equal(canceled.actual_tokens, null);
  assert.equal(canceled.reserved_tokens, pending.chargedTokens);
  await runner(
    "inference/result",
    { ...identity(), requestId: held.requestId },
    409,
  );
  await runner("finish", {
    ...identity(),
    outcome: "canceled",
    summary: "Stopped after cancellation",
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit: null,
    tokensUsed: 96,
    checks: [],
  });
  clearInterval(heartbeat);
  assert.deepEqual(heartbeatErrors, []);
  passed(
    "Mobile cancellation aborts active inference, withholds tool output, and retains unknown usage",
  );

  await fixture.restart();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "canceled" }).waitFor();
  await page.getByText("Tokens reserved", { exact: true }).waitFor();
  const persisted = await api(`runs/${claim.runId}`);
  assert.equal(persisted.usage.usedTokens, 96);
  assert.equal(persisted.usage.reservedTokens, pending.chargedTokens);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::integer AS count FROM verification_task_requests",
      )
    ).rows[0].count,
    4,
  );
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "Restart preserves both measured and uncertain charges without redispatching canceled work",
  );
  await writeFile(
    join(fixture.directory, "task-inference-results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  process.stdout.write(`Task inference evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "task-inference-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  await fixture.close();
}
