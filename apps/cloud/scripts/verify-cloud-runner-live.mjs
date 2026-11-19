import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";
import { runnerHistory } from "./cloud-runner-process.mjs";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "sonnet" },
    "claude-config": { type: "string", default: join(homedir(), ".claude") },
  },
});
const model = values.model;
const cliHomes = new Set();
const fixture = await cloudBrowserFixture();

async function signInClaude(provider) {
  const { organizationId } = (
    await fixture.database.query(
      'SELECT organization_id AS "organizationId" FROM cloud_ai_providers WHERE id=$1',
      [provider.id],
    )
  ).rows[0];
  const home = join(
    homedir(),
    ".machdoch-cloud",
    "cli",
    organizationId,
    provider.id,
  );
  cliHomes.add(join(homedir(), ".machdoch-cloud", "cli", organizationId));
  await mkdir(home, { recursive: true, mode: 0o700 });
  await copyFile(
    join(values["claude-config"], ".credentials.json"),
    join(home, ".credentials.json"),
  );
  const login = await api(`ai-providers/${provider.id}/login`);
  assert.equal(login.state, "signed-in", JSON.stringify(login));
  return login.account;
}
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
let worker;
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
    provider: "claude-code-cli",
    region: null,
    models: [model],
    apiKey: "",
    maxOutputTokens: 4096,
    dailyTokenBudget: 400000,
    maxConcurrentRequests: 1,
  });
  const account = await signInClaude(provider);
  const detected = await api("execution-sandbox");
  assert.deepEqual(detected.sandbox?.missing, []);
  const command = `node -e "const fs=require('node:fs'),a=require('node:assert/strict'),text=fs.readFileSync('README','utf8');a.equal(process.getuid(),1000);a.ok(text.startsWith('Hello World!'));a.equal((text.match(/MACHDOCH_LIVE_RUNNER_OK/g)||[]).length,1);console.log('README verified')"`;
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Live",
    target: "cloud",
    repository: "https://github.com/octocat/Hello-World",
    autopilot: false,
    providerId: provider.id,
    model,
    maxDurationSeconds: 600,
    maxTokens: 400000,
    requiredChecks: [{ name: "README marker", command, timeoutSeconds: 15 }],
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
  const queued = await api("runs", "POST", {
    profileId: profile.id,
    subject: {
      kind: "issue",
      id: issue.id,
      revision: (await api(`issues/${issue.id}`)).revision,
    },
  });
  const runId = queued.id;
  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "Runners" }).click();
  await page.getByText("This server · Running").waitFor({ timeout: 60000 });
  worker = (
    await api(`execution-workers?profileId=${profile.id}`)
  ).workers.find((entry) => entry.hosted);
  await page.goto(`${fixture.origin}/cloud/tasks/${runId}`);
  await page
    .getByRole("status")
    .filter({ hasText: /succeeded|failed/ })
    .waitFor({ timeout: 600000 });
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
  await api(`execution-workers/${worker.id}/revoke`, "POST", {});
  let state;
  await assertEventually(
    async () => {
      state = runnerHistory({
        stateDirectory: join(
          homedir(),
          ".machdoch-cloud",
          "runners",
          worker.id,
        ),
      });
      return true;
    },
    () => "The runner on this server did not stop.",
    60000,
  );
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
        provider: "claude-code-cli",
        account,
        model,
        runId,
        candidateCommit: result.candidateCommit,
        usage: result.usage,
        environments: state.environments,
        checks: [
          "Sandbox picked and pinned through the cloud",
          "Runner added on this server through the UI",
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
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  await fixture.close();
  for (const home of cliHomes) await rm(home, { recursive: true, force: true });
  if (worker)
    await rm(join(homedir(), ".machdoch-cloud", "runners", worker.id), {
      recursive: true,
      force: true,
    });
}
