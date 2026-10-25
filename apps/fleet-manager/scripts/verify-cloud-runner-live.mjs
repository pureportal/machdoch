import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudApi, cloudBrowserFixture } from "./cloud-browser-fixture.mjs";
import { startRunnerProcess, runnerHistory } from "./cloud-runner-process.mjs";

assert.ok(
  process.env.OPENAI_API_KEY,
  "Configure OPENAI_API_KEY for live execution verification",
);
assert.ok(
  process.env.MACHDOCH_VERIFY_MODEL,
  "Select MACHDOCH_VERIFY_MODEL for live execution verification",
);
assert.ok(
  process.env.MACHDOCH_SANDBOX_CONFIG,
  "Select a trusted sandbox artifact manifest",
);
const sandbox = JSON.parse(
  await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
);
const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
let runner;
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Live runner",
    key: "LIVE",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Live runner",
    description: "",
  });
  const provider = await api("ai-providers", "POST", {
    name: "Live runner",
    provider: "openai",
    region: null,
    models: [process.env.MACHDOCH_VERIFY_MODEL],
    apiKey: process.env.OPENAI_API_KEY,
    maxOutputTokens: 1024,
    dailyTokenBudget: 200000,
    maxConcurrentRequests: 1,
  });
  const command = `node -e "const fs=require('node:fs'),a=require('node:assert/strict'),text=fs.readFileSync('README','utf8');a.equal(process.getuid(),1000);a.ok(text.startsWith('Hello World!'));a.equal((text.match(/MACHDOCH_LIVE_RUNNER_OK/g)||[]).length,1);console.log('README verified')"`;
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Live",
    target: "cloud",
    repository: "https://github.com/octocat/Hello-World",
    baseCommit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
    providerId: provider.id,
    model: process.env.MACHDOCH_VERIFY_MODEL,
    maxDurationSeconds: 180,
    maxTokens: 200000,
    requiredChecks: [{ name: "README marker", command, timeoutSeconds: 15 }],
  });
  const worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Live worker",
  });
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Append the verification marker",
    description:
      "Append MACHDOCH_LIVE_RUNNER_OK on its own line in README, exactly once. Preserve the existing Hello World text.",
    acceptanceCriteria:
      "README preserves the original text and contains the marker exactly once.",
  });
  await page.goto(`${fixture.origin}/cloud/issues/${issue.id}`);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Execution profile").selectOption(profile.id);
  await form.getByRole("button", { name: "Queue task", exact: true }).click();
  await page.waitForURL(/\/cloud\/tasks\/[a-f0-9-]+$/);
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  runner = await startRunnerProcess(fixture, worker, sandbox, "live");
  const [exitCode] = await runner.finished;
  const calls = (
    await fixture.database.query(
      "SELECT user_prompt,response,state,error_code,actual_tokens,reserved_tokens FROM cloud_inference_calls WHERE run_id=$1 ORDER BY created_at,id",
      [runId],
    )
  ).rows;
  await writeFile(
    join(fixture.directory, "live-runner-transcript.json"),
    JSON.stringify({ result: await api(`runs/${runId}`), calls }, null, 2),
  );
  assert.equal(exitCode, 0, runner.logs());
  await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
  const result = await api(`runs/${runId}`);
  assert.equal(result.state, "succeeded");
  assert.ok(
    result.usage.usedTokens > 0 &&
      result.usage.usedTokens <= result.manifest.profile.maxTokens,
  );
  assert.equal(result.usage.reservedTokens, 0);
  const patch = result.artifacts.find(
    (file) =>
      file.kind === "diff" && file.candidateCommit === result.candidateCommit,
  );
  const response = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/v1/runs/${runId}/artifacts/${patch.id}`,
  );
  assert.equal(response.status(), 200);
  const bytes = await response.body();
  assert.equal(createHash("sha256").update(bytes).digest("hex"), patch.sha256);
  assert.ok(bytes.toString().includes("+MACHDOCH_LIVE_RUNNER_OK"));
  await writeFile(join(fixture.directory, "changes.patch"), bytes);
  assert.deepEqual(
    bytes
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("diff --git ")),
    ["diff --git a/README b/README"],
  );
  const state = runnerHistory(runner);
  assert.ok(state.environments.length >= 2);
  assert.ok(
    state.environments.every(
      (environment) => environment.stopReceipt?.processTreeStopped,
    ),
  );
  assert.equal((await api(`issues/${issue.id}`)).state, "backlog");
  assert.deepEqual(fixture.pageErrors, []);
  await page.screenshot({
    path: join(fixture.directory, "live-runner-result.png"),
    fullPage: true,
  });
  await writeFile(
    join(fixture.directory, "live-runner-results.json"),
    JSON.stringify(
      {
        model: process.env.MACHDOCH_VERIFY_MODEL,
        runId,
        candidateCommit: result.candidateCommit,
        usage: result.usage,
        environments: state.environments,
        checks: [
          "Task queued through the UI",
          "Live inference through the cloud broker",
          "Automatic repository preparation and editing",
          "Configured verification in a fresh VM",
          "Durable candidate and evidence",
          "All environments stopped before completion",
          "Issue remains open for review",
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `PASS Live autonomous runner completed ${result.usage.requests} model requests.\nEvidence: ${fixture.directory}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${runner?.logs() ?? ""}\n`,
  );
  process.exitCode = 1;
} finally {
  if (runner && runner.exitCode === null && runner.signalCode === null)
    runner.kill();
  await runner?.finished;
  await fixture.close();
}
