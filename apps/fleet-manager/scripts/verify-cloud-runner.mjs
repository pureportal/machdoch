import { startRunnerProcess, runnerHistory } from "./cloud-runner-process.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
  assertEventually,
} from "./cloud-browser-fixture.mjs";

assert.ok(
  process.env.MACHDOCH_SANDBOX_CONFIG,
  "Select a trusted sandbox artifact manifest",
);
const sandbox = JSON.parse(
  await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
);
const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-runner-fixture.ts",
});
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const children = new Set();
const checks = [];
const baseCommit = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const protectedCheck = `node -e "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(process.getuid(),1000);a.match(fs.readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);a.match(fs.readFileSync('README','utf8'),/MACHDOCH_RUNNER_VERIFIED/);a.throws(()=>fs.writeFileSync('README','tampered'));a.throws(()=>fs.unlinkSync('README'));a.throws(()=>fs.writeFileSync('.git/config','tampered'));for(const port of fs.readdirSync('/sys/class/virtio-ports'))a.throws(()=>fs.openSync('/dev/'+port,'w'));console.log('Protected validation passed')"`;
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function runProcess(worker, name, options) {
  const child = await startRunnerProcess(
    fixture,
    worker,
    sandbox,
    name,
    options,
  );
  children.add(child);
  return child;
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Runner",
    key: "RUN",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Runner",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
    { dailyTokenBudget: 500000 },
  );
  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  const form = page.getByRole("dialog");
  await form
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Autonomous runner");
  await form
    .getByLabel("Repository URL", { exact: true })
    .fill("https://github.com/octocat/Hello-World");
  await form.getByLabel("Base commit (SHA)", { exact: true }).fill(baseCommit);
  await form.getByLabel("Provider", { exact: true }).selectOption(provider.id);
  await form.getByLabel("Model", { exact: true }).selectOption("fixture");
  await form.getByLabel("Time limit (minutes)").fill("5");
  await form.getByLabel("Check name 1", { exact: true }).fill("README");
  await form
    .getByLabel("Check command 1", { exact: true })
    .fill(protectedCheck);
  await form.getByLabel("Check timeout 1", { exact: true }).fill("15");
  await form.getByRole("button", { name: "Add check", exact: true }).click();
  await form.getByLabel("Check name 2", { exact: true }).fill("Temporary");
  await form
    .getByRole("button", { name: "Remove check 2", exact: true })
    .click();
  await form.getByRole("button", { name: "Save profile", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  const profile = (await api("execution-profiles")).profiles[0];
  assert.deepEqual(profile.requiredChecks, [
    { name: "README", command: protectedCheck, timeoutSeconds: 15 },
  ]);
  const worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Autonomous worker",
  });
  passed(
    "Execution profiles retain explicit check commands and deadlines from the editor",
  );
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Implement runner marker",
    description: "Append MACHDOCH_RUNNER_VERIFIED to README.",
    acceptanceCriteria:
      "README contains the marker and protected validation passes.",
  });
  await page.goto(`${fixture.origin}/cloud/issues/${issue.id}`);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await form.getByLabel("Execution profile").selectOption(profile.id);
  await form.getByRole("button", { name: "Queue task", exact: true }).click();
  await page.waitForURL(/\/cloud\/tasks\/[a-f0-9-]+$/);
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  const workerProcess = await runProcess(worker, "repair");
  assert.equal((await workerProcess.finished)[0], 0, workerProcess.logs());
  await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
  const result = await api(`runs/${runId}`);
  assert.equal(result.state, "succeeded");
  assert.equal(result.attempts.length, 1);
  assert.equal(
    result.artifacts.filter((file) => file.kind === "candidate").length,
    2,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Download candidate.bundle", exact: true })
      .count(),
    1,
  );
  await page.getByText("Earlier candidates", { exact: true }).click();
  assert.equal(
    await page
      .getByRole("link", { name: "Download candidate.bundle", exact: true })
      .count(),
    2,
  );
  await page.getByText("Earlier candidates", { exact: true }).click();
  const records = (
    await fixture.database.query(
      "SELECT evidence FROM cloud_run_artifacts WHERE run_id=$1 AND kind='verification' ORDER BY created_at",
      [runId],
    )
  ).rows;
  assert.equal(records.length, 2);
  assert.notEqual(records[0].evidence.exitCode, 0);
  assert.equal(records[1].evidence.exitCode, 0);
  assert.ok(
    records.every(({ evidence }) => evidence.command === protectedCheck),
  );
  assert.equal((await api(`issues/${issue.id}`)).state, "backlog");
  const journal = runnerHistory(workerProcess);
  assert.deepEqual(
    journal.environments.map((environment) => environment.role),
    ["agent", "validation", "agent", "validation"],
  );
  assert.ok(
    journal.environments.every(
      (environment) => environment.stopReceipt?.processTreeStopped,
    ),
  );
  const candidate = result.artifacts
    .filter((file) => file.kind === "candidate")
    .at(-1);
  const response = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/v1/runs/${runId}/artifacts/${candidate.id}`,
  );
  assert.equal(response.status(), 200);
  assert.equal(
    createHash("sha256")
      .update(await response.body())
      .digest("hex"),
    candidate.sha256,
  );
  passed(
    "The CLI claims a queued issue, repairs failed verification in fresh VMs, stores results and confirms every shutdown",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "runner-result-mobile.png"),
    fullPage: true,
  });

  const noChangeProfile = await api("execution-profiles", "POST", {
    ...profile,
    id: undefined,
    revision: undefined,
    teamId: undefined,
    enabled: undefined,
    name: "Existing source",
    requiredChecks: [
      { name: "README", command: "test -s README", timeoutSeconds: 10 },
    ],
  });
  const noChangeWorker = await api("execution-workers", "POST", {
    profileId: noChangeProfile.id,
    name: "Existing source worker",
  });
  const noChangeRun = await api("runs", "POST", {
    profileId: noChangeProfile.id,
    subject: {
      kind: "project",
      id: project.id,
      revision: 1,
      purpose: "test",
      objective: "Verify existing repository",
      acceptanceCriteria: "README exists.",
    },
  });
  const noChange = await runProcess(noChangeWorker, "no-change");
  assert.equal((await noChange.finished)[0], 0, noChange.logs());
  const unchanged = await api(`runs/${noChangeRun.id}`);
  assert.equal(unchanged.state, "succeeded");
  const noChangeDiff = unchanged.artifacts.find((file) => file.kind === "diff");
  const noChangePatch = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/v1/runs/${noChangeRun.id}/artifacts/${noChangeDiff.id}`,
  );
  await writeFile(
    join(fixture.directory, "no-change.patch"),
    await noChangePatch.body(),
  );
  assert.equal(
    unchanged.artifacts.find((file) => file.kind === "diff").byteLength,
    0,
  );
  assert.equal(runnerHistory(noChange).environments.length, 2);
  passed(
    "A no-change task produces a recoverable snapshot from a shallow checkout without fabricating a patch",
  );

  const failedRun = await api("runs", "POST", {
    profileId: profile.id,
    subject: {
      kind: "project",
      id: project.id,
      revision: 1,
      purpose: "test",
      objective: "Fail after edit and retain the candidate",
      acceptanceCriteria: "Preserve the partial edit for review.",
    },
  });
  const failedWorker = await runProcess(worker, "failed-after-edit");
  assert.equal((await failedWorker.finished)[0], 1, failedWorker.logs());
  const failed = await api(`runs/${failedRun.id}`);
  assert.equal(failed.state, "failed");
  assert.equal(
    failed.artifacts.some((file) => file.kind === "verification"),
    false,
  );
  const partial = failed.artifacts.find((file) => file.kind === "diff");
  const partialDownload = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/v1/runs/${failedRun.id}/artifacts/${partial.id}`,
  );
  const partialPatch = await partialDownload.text();
  assert.match(partialPatch, /BROKEN_CANDIDATE/);
  assert.doesNotMatch(partialPatch, /diff --git a\/\.machdoch\//);
  await writeFile(
    join(fixture.directory, "failed-candidate.patch"),
    partialPatch,
  );
  assert.ok(
    runnerHistory(failedWorker).environments.every(
      (environment) => environment.stopReceipt?.processTreeStopped,
    ),
  );
  passed(
    "Provider failure after an edit retains an unverified candidate and stops every agent process",
  );

  const lowProfile = await api("execution-profiles", "POST", {
    ...profile,
    id: undefined,
    revision: undefined,
    teamId: undefined,
    enabled: undefined,
    name: "Small allowance",
    maxTokens: 1000,
  });
  const lowWorker = await api("execution-workers", "POST", {
    profileId: lowProfile.id,
    name: "Small allowance worker",
  });
  const lowRun = await api("runs", "POST", {
    profileId: lowProfile.id,
    subject: {
      kind: "project",
      id: project.id,
      revision: 1,
      purpose: "test",
      objective: "Verify existing source with a small allowance",
      acceptanceCriteria: "Do not exceed the allowance.",
    },
  });
  const lowProcess = await runProcess(lowWorker, "small-allowance");
  assert.equal((await lowProcess.finished)[0], 1, lowProcess.logs());
  const low = await api(`runs/${lowRun.id}`);
  assert.equal(low.state, "failed");
  assert.equal(low.usage.requests, 0);
  assert.equal(low.manifest.profile.maxTokens, 1000);
  assert.match(low.summary, /allowance/);
  assert.ok(
    runnerHistory(lowProcess).environments.every(
      (environment) => environment.stopReceipt?.processTreeStopped,
    ),
  );
  passed(
    "An insufficient allowance fails before provider admission without increasing its grant",
  );

  const reconnectWorker = await api("execution-workers", "POST", {
    profileId: noChangeProfile.id,
    name: "Reconnecting worker",
  });
  const daemon = await runProcess(reconnectWorker, "reconnect", {
    once: false,
  });
  await assertEventually(
    async () =>
      (
        await api(`execution-workers?profileId=${noChangeProfile.id}`)
      ).workers.find((entry) => entry.id === reconnectWorker.id).lastSeenAt !==
      null,
  );
  await fixture.restart();
  const reconnectedRun = await api("runs", "POST", {
    profileId: noChangeProfile.id,
    subject: {
      kind: "project",
      id: project.id,
      revision: 1,
      purpose: "test",
      objective: "Verify existing source after reconnect",
      acceptanceCriteria: "README exists.",
    },
  });
  await assertEventually(
    async () =>
      daemon.logs().includes(`"runId":"${reconnectedRun.id}"`) &&
      daemon.logs().includes('"state":"succeeded"'),
    () => daemon.logs(),
    90000,
  );
  daemon.kill();
  await daemon.finished;
  assert.equal((await api(`runs/${reconnectedRun.id}`)).state, "succeeded");
  assert.ok(
    runnerHistory(daemon).environments.every(
      (environment) => environment.stopReceipt?.processTreeStopped,
    ),
  );
  passed(
    "An idle daemon reconnects after a server restart and continues queued work",
  );

  const held = await api("runs", "POST", {
    profileId: profile.id,
    subject: {
      kind: "project",
      id: project.id,
      revision: 1,
      purpose: "test",
      objective: "Hold runner inference",
      acceptanceCriteria: "Stop on cancellation.",
    },
  });
  const canceled = await runProcess(worker, "cancellation");
  await assertEventually(
    async () =>
      (
        await fixture.database.query(
          "SELECT count(*)::integer AS count FROM verification_runner_calls WHERE title='Hold runner inference' AND state='held'",
        )
      ).rows[0].count === 1,
    undefined,
    60000,
  );
  await page.goto(`${fixture.origin}/cloud/tasks/${held.id}`);
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await form.getByRole("button", { name: "Cancel task", exact: true }).click();
  assert.equal((await canceled.finished)[0], 1, canceled.logs());
  await page.getByRole("status").filter({ hasText: "canceled" }).waitFor();
  assert.ok(
    runnerHistory(canceled).environments.every(
      (environment) =>
        !environment.launchRequested ||
        environment.stopReceipt?.processTreeStopped,
    ),
  );
  passed(
    "Browser cancellation stops the automatic worker and retains no unconfirmed environment",
  );
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "runner-results.json"),
    JSON.stringify(
      { checks, usage: result.usage, pageErrors: fixture.pageErrors },
      null,
      2,
    ),
  );
  process.stdout.write(`Runner evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "runner-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.finished;
  }
  await fixture.close();
}
