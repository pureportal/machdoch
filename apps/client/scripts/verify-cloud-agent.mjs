import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSupervisor } from "@machdoch/cloud-client/supervisor";
import { cloudAgentInferenceSchema } from "@machdoch/fleet-protocol/cloud-agent";

assert.ok(
  process.env.MACHDOCH_CLOUD_SUPERVISOR,
  "Set MACHDOCH_CLOUD_SUPERVISOR.",
);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(project, "../..");
const storage = join(root, ".tmp/cloud-agent-verification");
await mkdir(storage, { recursive: true });
const directory = await mkdtemp(join(storage, "case-"));
const checks = [];
for (const scenario of [
  "complete",
  "large-response",
  "stale-reply",
  "broker-failure",
  "lease-expired",
  "auxiliary-failure",
]) {
  const successful = scenario === "complete" || scenario === "large-response";
  const expectedContent =
    scenario === "large-response" ? "λ".repeat(40000) : "shared runtime output";
  const work = join(directory, scenario);
  const checkout = join(work, "checkout"),
    state = join(work, "state"),
    ownerState = join(work, "owner");
  for (const path of [checkout, state, ownerState])
    await mkdir(path, { recursive: true });
  let buffer = Buffer.alloc(0),
    stderr = "",
    completed;
  let requests = 0,
    settled = false,
    queued = Promise.resolve();
  let readyResolve, readyReject, doneResolve, doneReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  void ready.catch(() => {});
  void done.catch(() => {});
  function fail(error) {
    readyReject(error);
    doneReject(error);
  }
  const supervisor = new NativeSupervisor(
    process.env.MACHDOCH_CLOUD_SUPERVISOR,
    (kind, bytes) => {
      if (kind === "stderr") {
        stderr = (stderr + bytes).slice(-8192);
        return;
      }
      buffer = Buffer.concat([buffer, bytes]);
      assert.ok(buffer.length <= 512 * 1024, "Agent frame exceeded its limit");
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const frame = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        buffer = buffer.subarray(newline + 1);
        if (frame.kind === "sandbox_ready") readyResolve();
        else if (frame.kind === "complete") {
          completed = frame;
          doneResolve();
        } else if (frame.kind === "inference") {
          const request = cloudAgentInferenceSchema.parse(frame.request);
          requests++;
          assert.ok(
            requests <= 4,
            "The agent retried an uncertain broker outcome",
          );
          queued = queued
            .then(async () => {
              if (scenario === "lease-expired") {
                await supervisor.renew(await supervisor.anchor(), 1000);
                return;
              }
              let response;
              if (!request.tools.length) {
                assert.equal(
                  request.modelOptions.structuredOutput.name,
                  "reasoning_bank_lessons",
                );
                response = {
                  text: JSON.stringify({
                    outcome: "success",
                    helpfulLessonIds: [],
                    harmfulLessonIds: [],
                    lessons: [],
                  }),
                  toolCalls: [],
                };
              } else if (
                request.tools.some(
                  (tool) => tool.name === "report_autopilot_decision",
                )
              ) {
                response = {
                  text: "",
                  toolCalls: [
                    {
                      id: "monitor",
                      name: "report_autopilot_decision",
                      arguments: {
                        decision: "complete",
                        confidence: "high",
                        rationale: "The file was created.",
                        missingRequirements: [],
                        requiredActions: [],
                      },
                    },
                  ],
                };
              } else if (
                request.context.includes("Created agent-result.txt.")
              ) {
                response = {
                  text: "",
                  toolCalls: [
                    {
                      id: "done",
                      name: "submit_final_response",
                      arguments: {
                        summary: "Created agent-result.txt.",
                        status: "completed",
                        blockerReason: "",
                        markdown: "Created agent-result.txt.",
                        highlights: [],
                        relatedFiles: [],
                        verification: [],
                        followUps: [],
                      },
                    },
                  ],
                };
              } else {
                assert.ok(
                  request.tools.some((tool) => tool.name === "create_file"),
                );
                assert.ok(
                  !request.tools.some((tool) =>
                    /scheduler|schedule|workflow|mcp|browser|speech|parallel/iu.test(
                      tool.name,
                    ),
                  ),
                );
                response = {
                  text: "",
                  toolCalls: [
                    {
                      id: "create",
                      name: "create_file",
                      arguments: {
                        path: "agent-result.txt",
                        content: expectedContent,
                      },
                    },
                  ],
                };
              }
              const reply =
                scenario === "broker-failure" ||
                (scenario === "auxiliary-failure" && !request.tools.length)
                  ? {
                      kind: "inference_error",
                      requestId: request.requestId,
                      error: "Provider outcome is uncertain.",
                    }
                  : {
                      kind: "inference_result",
                      requestId:
                        scenario === "stale-reply"
                          ? randomUUID()
                          : request.requestId,
                      response,
                    };
              await supervisor.writeInput(
                Buffer.from(JSON.stringify(reply) + "\n"),
              );
            })
            .catch(fail);
        } else assert.equal(frame.kind, "progress");
      }
    },
  );
  supervisor.signal.addEventListener(
    "abort",
    () => {
      settled = true;
      readyReject(new Error(stderr || "Sandbox startup did not complete"));
      if (successful)
        fail(new Error(stderr || "Agent stopped before completion"));
      else doneResolve();
    },
    { once: true },
  );
  const receiptPath = join(work, "stopped.json");
  try {
    await supervisor.prepareReceipt(receiptPath, randomUUID());
    await supervisor.start({
      anchorId: await supervisor.anchor(),
      allowanceMs: 20000,
      maxDurationMs: 30000,
      memoryLimitBytes: 1024 * 1024 * 1024,
      program: process.execPath,
      args: [join(project, "dist/machdoch-cloud-sandbox.cjs")],
      directory: project,
      environment: {
        SystemRoot: process.env.SystemRoot,
        PATH: dirname(process.execPath),
        LOCALAPPDATA: ownerState,
        TEMP: ownerState,
      },
    });
    const agent = join(project, "dist/machdoch-cloud-agent.cjs");
    await supervisor.writeInput(
      Buffer.from(
        JSON.stringify({
          access: "workspace",
          executable: process.execPath,
          arguments: [agent],
          checkoutDirectory: checkout,
          stateDirectory: state,
          readonlyPaths: [agent],
          durationMs: 25000,
        }) + "\n",
      ),
    );
    await ready;
    await supervisor.writeInput(
      Buffer.from(
        JSON.stringify({
          kind: "start",
          task:
            scenario === "large-response"
              ? "Use the agent tools to create agent-result.txt containing exactly 40,000 lowercase lambda characters."
              : "Create agent-result.txt containing exactly: shared runtime output",
          provider: "openai",
          model: "fixture",
          contextLimitBytes: 48 * 1024,
          durationMs: 15000,
        }) + "\n",
      ),
    );
    await done;
    await queued;
    await supervisor.close();
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(
      join(work, "observed.json"),
      JSON.stringify(
        { requests, result: completed ?? null, receipt, stderr },
        null,
        2,
      ),
    );
    assert.equal(receipt.processTreeStopped, true);
    if (successful) {
      assert.equal(completed?.status, "executed");
      assert.equal(
        await readFile(join(checkout, "agent-result.txt"), "utf8"),
        expectedContent,
      );
      assert.equal(requests, 4);
      assert.equal(stderr, "");
    } else {
      assert.equal(settled, true);
      assert.equal(requests, scenario === "auxiliary-failure" ? 4 : 1);
      assert.notEqual(completed?.status, "executed");
      if (scenario === "auxiliary-failure")
        assert.equal(
          await readFile(join(checkout, "agent-result.txt"), "utf8"),
          "shared runtime output",
        );
      else
        await assert.rejects(readFile(join(checkout, "agent-result.txt")), {
          code: "ENOENT",
        });
      if (scenario === "lease-expired")
        assert.equal(receipt.reason, "lease_expired");
    }
    checks.push({ scenario, requests, receipt, result: completed ?? null });
    process.stdout.write(`PASS ${scenario}\n`);
  } finally {
    await supervisor.close();
  }
}
await writeFile(
  join(directory, "results.json"),
  JSON.stringify(
    { checks, agentExecuted: true, provider: "controlled" },
    null,
    2,
  ),
);
process.stdout.write(`Shared agent evidence: ${directory}\n`);
