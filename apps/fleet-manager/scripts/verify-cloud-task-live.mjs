import { taskAgentTools } from "@machdoch/fleet-protocol/cloud-agent-tools";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VirtualMachineSandbox } from "../../../packages/cloud-client/src/worker/sandbox/virtual-machine.ts";
import {
  uploadRunnerArtifact,
  verificationRecord,
} from "./cloud-artifact-fixture.mjs";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

assert.ok(
  process.env.OPENAI_API_KEY,
  "Set OPENAI_API_KEY for live sandbox verification.",
);
assert.ok(
  process.env.MACHDOCH_VERIFY_MODEL,
  "Select MACHDOCH_VERIFY_MODEL for live sandbox verification.",
);
assert.ok(
  process.env.MACHDOCH_SANDBOX_CONFIG,
  "Select a trusted WHPX artifact manifest with MACHDOCH_SANDBOX_CONFIG.",
);
const configuration = JSON.parse(
  await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
);
const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const runnerContext = await fixture.createContext();
const api = (path, method, data) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data);
let sandbox;
let recoverySandbox;
let worker;
let claim;
let heartbeat;
let closing = false;
let heartbeatError;
const identity = () => ({
  runId: claim.runId,
  attemptId: claim.attemptId,
  epoch: claim.epoch,
});
async function runner(path, data) {
  const response = await runnerContext.request.post(
    `${fixture.origin}/api/v1/runner/${path}`,
    {
      headers: { Authorization: `Bearer ${worker.token}` },
      data,
    },
  );
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function shell(command) {
  const response = await sandbox.call("shell", { command, timeoutMs: 10000 });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.exitCode, 0, JSON.stringify(response.result));
  return response.result;
}
async function renew() {
  if (closing) return;
  try {
    const anchor = await sandbox.supervisor.anchor();
    const receipt = await runner("heartbeat", identity());
    if (closing) return;
    assert.equal(receipt.instruction, "continue");
    await sandbox.supervisor.renew(anchor, receipt.localStopSeconds * 1000);
  } catch (error) {
    if (!closing) {
      heartbeatError = error;
      await sandbox.close().catch(() => {});
    }
  } finally {
    if (!closing && !heartbeatError)
      heartbeat = setTimeout(() => void renew(), 15000);
  }
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Sandbox verification",
    key: "VM",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Sandbox fixture",
    description: "",
  });
  const provider = await api("ai-providers", "POST", {
    name: "Live sandbox provider",
    provider: "openai",
    region: null,
    models: [process.env.MACHDOCH_VERIFY_MODEL],
    apiKey: process.env.OPENAI_API_KEY,
    maxOutputTokens: 512,
    dailyTokenBudget: 100000,
    maxConcurrentRequests: 1,
  });
  sandbox = await VirtualMachineSandbox.create(
    { ...configuration, backend: "whpx" },
    {
      directory: fixture.directory,
      environmentId: randomUUID(),
    },
  );
  await sandbox.start(await sandbox.supervisor.anchor(), 60000, 600000);
  assert.equal(
    (
      await sandbox.call("write_file", {
        path: "add.mjs",
        content: "export const add = (a, b) => a - b;\n",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await sandbox.call("write_file", {
        path: "add.test.mjs",
        content:
          "import { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\nimport { add } from './add.mjs';\ntest('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 1), -1); });\n",
      })
    ).ok,
    true,
  );
  const initial = await sandbox.call("shell", {
    command: "node --test add.test.mjs",
    timeoutMs: 10000,
  });
  assert.equal(initial.ok, true);
  assert.notEqual(initial.result.exitCode, 0);
  await shell(
    "git init -q && git -c user.name=Verification -c user.email=verification@example.test add add.mjs add.test.mjs && git -c user.name=Verification -c user.email=verification@example.test commit -qm fixture",
  );
  const baseCommit = (await shell("git rev-parse HEAD")).stdout.trim();
  assert.match(baseCommit, /^[a-f0-9]{40}$/);
  const validationCommand =
    "node --test add.test.mjs && node --input-type=module -e \"import {add} from './add.mjs'; if(add(2,3)!==5 || add(-2,1)!==-1) throw new Error('incorrect addition');\" && git diff --exit-code HEAD^ HEAD -- add.test.mjs";
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Live VM",
    target: "cloud",
    repository: "https://github.com/example/sandbox-fixture",
    baseCommit,
    providerId: provider.id,
    model: process.env.MACHDOCH_VERIFY_MODEL,
    maxDurationSeconds: 600,
    maxTokens: 100000,
    requiredChecks: [
      { name: "addition", command: validationCommand, timeoutSeconds: 10 },
    ],
  });
  worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Local WHPX verification",
  });
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Fix addition in add.mjs",
    description:
      "The workspace contains add.mjs and add.test.mjs. Fix the implementation without modifying the tests. Run node --test add.test.mjs, then report the result.",
    acceptanceCriteria:
      "Addition returns 5 for (2,3), -1 for (-2,1), and all existing tests pass.",
  });
  await api("runs", "POST", {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  const claimAnchor = await sandbox.supervisor.anchor();
  const claimed = await runner("claims", { claimId: randomUUID() });
  claim = claimed.claim;
  assert.ok(claim);
  await sandbox.supervisor.renew(claimAnchor, claimed.localStopSeconds * 1000);
  const acceptAnchor = await sandbox.supervisor.anchor();
  const accepted = await runner("accept", {
    ...identity(),
    environmentId: sandbox.environmentId,
    baseCommit,
    isolation: "microvm",
  });
  assert.equal(accepted.instruction, "continue");
  await sandbox.supervisor.renew(
    acceptAnchor,
    accepted.localStopSeconds * 1000,
  );
  heartbeat = setTimeout(() => void renew(), 15000);
  await page.goto(`${fixture.origin}/cloud/tasks/${claim.runId}`);
  const history = [];
  const requests = [];
  let summary;
  for (let index = 0; index < 8; index++) {
    if (heartbeatError) throw heartbeatError;
    const requestId = randomUUID();
    await runner("inference", {
      ...identity(),
      requestId,
      runtimePrompt: "",
      modelOptions: {},
      tools: taskAgentTools,
      context: JSON.stringify(
        history.length
          ? history
          : [
              {
                role: "user",
                content: "Begin by inspecting the two workspace files.",
              },
            ],
      ),
    });
    let receipt;
    await assertEventually(
      async () => {
        receipt = await runner("inference/result", {
          ...identity(),
          requestId,
        });
        return !["queued", "running", "cancel_requested"].includes(
          receipt.state,
        );
      },
      () => `Inference did not finish: ${JSON.stringify(receipt)}`,
      120000,
    );
    assert.equal(receipt.state, "complete", JSON.stringify(receipt));
    requests.push({ requestId, tokens: receipt.chargedTokens });
    history.push({ role: "assistant", ...receipt.response });
    if (!receipt.response.toolCalls.length) {
      summary = receipt.response.text;
      await writeFile(
        join(fixture.directory, "live-task-transcript.json"),
        JSON.stringify(history, null, 2),
      );
      break;
    }
    for (const call of receipt.response.toolCalls) {
      const result = await sandbox.call(call.name, call.arguments);
      history.push({ role: "tool", callId: call.id, name: call.name, result });
    }
    await writeFile(
      join(fixture.directory, "live-task-transcript.json"),
      JSON.stringify(history, null, 2),
    );
    process.stdout.write(
      `Live task step ${index + 1}: ${receipt.response.toolCalls.map((call) => call.name).join(", ")}\n`,
    );
  }
  assert.ok(
    summary,
    "The agent did not finish within eight inference requests.",
  );
  await runner("progress", { ...identity(), state: "validating" });
  await shell(
    "git -c core.hooksPath=/dev/null add add.mjs && git -c core.hooksPath=/dev/null -c user.name=Verification -c user.email=verification@example.test commit -qm fix-addition",
  );
  const candidateCommit = (await shell("git rev-parse HEAD")).stdout.trim();
  assert.notEqual(candidateCommit, baseCommit);
  const validationStarted = performance.now();
  const validation = await shell(validationCommand);
  const evidence = verificationRecord(candidateCommit, {
    name: "addition",
    command: validationCommand,
    ...validation,
    durationMs: Math.round(performance.now() - validationStarted),
  });
  const evidenceArtifact = await uploadRunnerArtifact(
    runner,
    claim,
    "verification",
    "addition.json",
    Buffer.from(JSON.stringify(evidence)),
    candidateCommit,
  );
  await shell(
    "git -c core.hooksPath=/dev/null bundle create candidate.bundle HEAD",
  );
  const bundle = await sandbox.call("read_file", {
    path: "candidate.bundle",
    encoding: "base64",
    limit: 262144,
  });
  assert.equal(bundle.ok, true);
  const bundleBytes = Buffer.from(bundle.result.content, "base64");
  assert.equal(bundleBytes.length, bundle.result.size);
  const candidateArtifact = await uploadRunnerArtifact(
    runner,
    claim,
    "candidate",
    "candidate.bundle",
    bundleBytes,
    candidateCommit,
  );
  const diff = await shell(
    `git -c core.hooksPath=/dev/null diff --binary ${baseCommit} ${candidateCommit}`,
  );
  await uploadRunnerArtifact(
    runner,
    claim,
    "diff",
    "changes.patch",
    Buffer.from(diff.stdout),
    candidateCommit,
  );
  const finalFile = await sandbox.call("read_file", { path: "add.mjs" });
  closing = true;
  clearTimeout(heartbeat);
  await sandbox.close();
  const finished = await runner("finish", {
    ...identity(),
    outcome: "succeeded",
    summary,
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit,
    tokensUsed: requests.reduce((total, request) => total + request.tokens, 0),
    checks: [
      {
        name: "addition",
        passed: true,
        candidateCommit,
        evidenceDigest: evidenceArtifact.sha256,
      },
    ],
  });
  assert.equal(finished.accepted, true);
  const savedResponse = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/v1/runs/${claim.runId}/artifacts/${candidateArtifact.id}`,
  );
  assert.equal(savedResponse.status(), 200);
  const saved = await savedResponse.body();
  assert.equal(
    createHash("sha256").update(saved).digest("hex"),
    candidateArtifact.sha256,
  );
  recoverySandbox = await VirtualMachineSandbox.create(
    { ...configuration, backend: "whpx" },
    {
      directory: fixture.directory,
      environmentId: randomUUID(),
    },
  );
  await recoverySandbox.start(
    await recoverySandbox.supervisor.anchor(),
    60000,
    120000,
  );
  assert.equal(
    (
      await recoverySandbox.call("write_file", {
        path: "candidate.base64",
        content: saved.toString("base64"),
      })
    ).ok,
    true,
  );
  const recovered = await recoverySandbox.call("shell", {
    command: `base64 -d candidate.base64 > candidate.bundle && git init -q recovered && git -C recovered fetch -q ../candidate.bundle HEAD && git -C recovered checkout -q --detach FETCH_HEAD && cd recovered && test "$(git rev-parse HEAD)" = '${candidateCommit}' && node --test add.test.mjs`,
    timeoutMs: 10000,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.result.exitCode, 0, JSON.stringify(recovered));
  await recoverySandbox.close();
  await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
  await page.getByText("Execution details", { exact: true }).click();
  await page.getByText("Tokens used", { exact: true }).waitFor();
  assert.deepEqual(fixture.pageErrors, []);
  await page.screenshot({
    path: join(fixture.directory, "live-sandbox-task.png"),
    fullPage: true,
  });
  await writeFile(
    join(fixture.directory, "live-sandbox-results.json"),
    JSON.stringify(
      {
        model: process.env.MACHDOCH_VERIFY_MODEL,
        baseCommit,
        candidateCommit,
        requests,
        finalFile,
        validation,
        summary,
        checks: [
          "Initial failing test",
          "Live provider tool selection through the cloud broker",
          "File edits and shell execution inside WHPX VM",
          "Original tests unchanged",
          "Candidate-bound passing validation",
          "Supervisor stopped before success",
          "Candidate bundle and check evidence stored before completion",
          "Downloaded candidate restored and tested in a fresh VM after the first VM stopped",
          "Task UI and metered usage",
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `PASS Live provider completed the sandbox fixture in ${requests.length} requests.\nEvidence: ${fixture.directory}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  await page
    .screenshot({
      path: join(fixture.directory, "live-sandbox-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  closing = true;
  clearTimeout(heartbeat);
  await sandbox
    ?.close()
    .catch((error) =>
      process.stderr.write(`Sandbox cleanup: ${error.message}\n`),
    );
  await recoverySandbox
    ?.close()
    .catch((error) =>
      process.stderr.write(`Recovery sandbox cleanup: ${error.message}\n`),
    );
  await fixture.close();
}
