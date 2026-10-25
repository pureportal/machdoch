import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  agentInference,
  runAgent,
} from "../../../packages/cloud-client/src/worker/agent-loop.ts";
import { RunnerConnection } from "@machdoch/cloud-client";
import { claimFixture } from "./test-fixture.ts";
import type { VirtualMachineSandbox } from "../../../packages/cloud-client/src/worker/sandbox/virtual-machine.ts";
import type { CloudAgentInference } from "@machdoch/fleet-protocol/cloud-agent";
import {
  taskInferencePayload,
  taskInferenceReservationOverhead,
} from "@machdoch/fleet-protocol/cloud-task-context";

const token = "mch_cloud_worker_" + "a".repeat(43);
const environment = {
  sandbox: {} as VirtualMachineSandbox,
  signal: new AbortController().signal,
};
const request = (): CloudAgentInference => ({
  requestId: randomUUID(),
  runtimePrompt: "Shared runtime",
  tools: [],
  modelOptions: {},
  context: "Task context",
});
function receipt(id: string, chargedTokens = 32) {
  return {
    requestId: id,
    state: "complete",
    response: { text: "Updated source", toolCalls: [] },
    errorCode: null,
    chargedTokens,
  };
}

await test("retries lost inference admission with the original identity and charges its receipt once", async () => {
  const inputs: unknown[] = [];
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    token,
    async (url, options) => {
      if (String(url).endsWith("/progress"))
        return Response.json({ instruction: "continue" });
      const input = JSON.parse(String(options?.body));
      inputs.push(input);
      if (inputs.length === 1) throw new TypeError("fetch failed");
      return Response.json(receipt(input.requestId));
    },
  );
  const usage = { tokens: 0, requests: 0 };
  const result = await agentInference(
    connection,
    claimFixture(),
    environment,
    usage,
    request(),
  );
  assert.equal(result.kind, "inference_result");
  assert.deepEqual(inputs[0], inputs[1]);
  assert.deepEqual(usage, { tokens: 32, requests: 1 });
});
await test("rejects mismatched receipts without forwarding a model reply", async () => {
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    token,
    async (url) =>
      Response.json(
        String(url).endsWith("/progress")
          ? { instruction: "continue" }
          : receipt(randomUUID()),
      ),
  );
  const result = await agentInference(
    connection,
    claimFixture(),
    environment,
    { tokens: 0, requests: 0 },
    request(),
  );
  assert.equal(result.kind, "inference_error");
  if (result.kind === "inference_error")
    assert.match(result.error, /another request/);
});
await test("checks current authority after inference before returning tools to the agent", async () => {
  let checks = 0;
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    token,
    async (url, options) =>
      Response.json(
        String(url).endsWith("/progress")
          ? { instruction: ++checks === 1 ? "continue" : "stop" }
          : receipt(JSON.parse(String(options?.body)).requestId),
      ),
  );
  const result = await agentInference(
    connection,
    claimFixture(),
    environment,
    { tokens: 0, requests: 0 },
    request(),
  );
  assert.equal(result.kind, "inference_error");
});
await test("negotiates context before purchasing inference without changing the granted budget", async () => {
  const claim = claimFixture(),
    input = request();
  input.context = "x".repeat(4000);
  const base = taskInferencePayload(claim.manifest, {
    ...input,
    context: "",
  }).inputBytes;
  claim.manifest.profile.maxTokens =
    base +
    taskInferenceReservationOverhead +
    claim.manifest.provider.maxOutputTokens +
    2000;
  const maximum = claim.manifest.profile.maxTokens;
  const usage = { tokens: 1000, requests: 1 };
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    token,
    async (url) => {
      assert.ok(String(url).endsWith("/progress"));
      return Response.json({ instruction: "continue" });
    },
  );
  const result = await agentInference(
    connection,
    claim,
    environment,
    usage,
    input,
  );
  assert.equal(result.kind, "inference_limit");
  if (result.kind === "inference_limit")
    assert.equal(result.contextLimitBytes, 1000);
  assert.equal(claim.manifest.profile.maxTokens, maximum);
  assert.deepEqual(usage, { tokens: 1000, requests: 1 });
});
await test("stops before inference when runtime instructions consume the remaining allowance", async () => {
  const claim = claimFixture();
  claim.manifest.profile.maxTokens = 1;
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    token,
    async (url) => {
      assert.ok(String(url).endsWith("/progress"));
      return Response.json({ instruction: "continue" });
    },
  );
  const result = await agentInference(
    connection,
    claim,
    environment,
    { tokens: 0, requests: 0 },
    request(),
  );
  assert.equal(result.kind, "inference_error");
});
await test("passes the immutable task to the shared agent and requires process-tree stop proof", async () => {
  const claim = claimFixture();
  claim.manifest.profile.workspacePath = "apps/worker";
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    token,
    async () => Response.json({ instruction: "continue" }),
  );
  const call: VirtualMachineSandbox["call"] = async (
    tool,
    args,
    signal,
    _id,
    transport,
  ) => {
    assert.equal(tool, "run_agent");
    assert.equal(args.directory, "apps/worker");
    assert.equal(signal?.aborted, false);
    assert.ok(transport);
    const start = JSON.parse(String(args.start));
    assert.equal(start.provider, claim.manifest.provider.provider);
    assert.equal(JSON.parse(start.task).objective, claim.manifest.objective);
    return {
      id: randomUUID(),
      ok: true,
      result: {
        status: "executed",
        summary: "Done",
        processTreeStopped: false,
      },
    };
  };
  await assert.rejects(
    runAgent(
      connection,
      claim,
      { ...environment, sandbox: { call } as unknown as VirtualMachineSandbox },
      { tokens: 0, requests: 0 },
    ),
  );
});
