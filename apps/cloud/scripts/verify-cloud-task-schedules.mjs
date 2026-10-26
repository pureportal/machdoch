import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudBrowserFixture,
  cloudApi,
  assertEventually,
  executionProviderFixture,
  createPasswordInvitation,
  acceptPasswordInvitation,
} from "./cloud-browser-fixture.mjs";
import { cloudTemporalFixture } from "./cloud-temporal-fixture.mjs";
import { startCloudWorkflowWorker } from "./cloud-workflow-worker-fixture.mjs";
import { startRunnerProcess, runnerHistory } from "./cloud-runner-process.mjs";
import { PostgresCloudDatabase } from "../src/server/cloud/database.ts";
import { createCloudRuntime } from "../src/server/cloud/runtime.ts";

assert.ok(
  process.env.MACHDOCH_SANDBOX_CONFIG,
  "Select the verified sandbox artifact manifest using MACHDOCH_SANDBOX_CONFIG.",
);
const sandbox = JSON.parse(
  await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
);
let dropStatePath = null;
const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-runner-fixture.ts",
  dropResponse: ({ path, status }) => path === dropStatePath && status === 200,
});
const api = (path, method, body, key) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body, key);
const page = await fixture.ownerContext.newPage();
const checks = [];
const passed = (name) => {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
let temporal, workflowWorker, runner, database;
const installationId = randomUUID();
const stopWorkflow = async () => {
  if (workflowWorker?.exitCode === null) workflowWorker.kill();
  await workflowWorker?.finished;
  workflowWorker = undefined;
};
const startWorkflow = async () => {
  workflowWorker = startCloudWorkflowWorker(fixture, temporal, installationId);
  await assertEventually(
    async () => {
      if (workflowWorker.exitCode !== null)
        throw new Error(workflowWorker.logs());
      return (await api("schedules/status")).available;
    },
    () => `Workflow did not start. ${workflowWorker.logs()}`,
    30000,
  );
};
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Automation",
    key: "AT",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    name: "Automation project",
    teamId: team.id,
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    name: "Sandbox",
    projectId: project.id,
    target: "cloud",
    repository: "https://github.com/octocat/Hello-World",
    baseCommit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 300,
    maxTokens: 200000,
    requiredChecks: [
      {
        name: "README",
        command:
          "node -e \"const fs=require('node:fs'),a=require('node:assert/strict');a.equal(process.getuid(),1000);a.match(fs.readFileSync('README','utf8'),/MACHDOCH_RUNNER_VERIFIED/);a.throws(()=>fs.writeFileSync('README','tampered'));console.log('Protected check passed')\"",
        timeoutSeconds: 15,
      },
    ],
  });
  const worker = await api("execution-workers", "POST", {
    name: "Scheduled cloud worker",
    profileId: profile.id,
  });
  temporal = await cloudTemporalFixture(join(fixture.directory, "temporal"));
  await startWorkflow();
  database = new PostgresCloudDatabase(
    fixture.environment.MACHDOCH_CLOUD_DATABASE_URL,
  );
  const runtime = createCloudRuntime(database, fixture.origin);
  await page.goto(`${fixture.origin}/cloud/schedules`);
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Scheduled implementation");
  await page.route("**/api/v1/execution-profiles", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Profiles unavailable. Try again.",
        code: "unavailable",
      }),
    }),
  );
  await dialog.getByLabel("Action", { exact: true }).selectOption("run-task");
  await dialog
    .getByRole("button", { name: "Reload profiles", exact: true })
    .waitFor();
  await dialog
    .getByLabel("Objective", { exact: true })
    .fill(
      "Implement scheduled marker\nAppend MACHDOCH_RUNNER_VERIFIED to README.",
    );
  await page.unroute("**/api/v1/execution-profiles");
  await dialog
    .getByRole("button", { name: "Reload profiles", exact: true })
    .click();
  await dialog
    .getByLabel("Execution profile", { exact: true })
    .selectOption(profile.id);
  assert.match(
    await dialog.getByLabel("Objective", { exact: true }).inputValue(),
    /Implement scheduled marker/,
  );
  await dialog
    .getByLabel("Acceptance criteria", { exact: true })
    .fill("README contains the marker and protected validation passes.");
  await dialog.getByLabel("Maximum tasks", { exact: true }).fill("1");
  await dialog
    .getByLabel("Total token allowance", { exact: true })
    .fill("100000");
  const expires = new Date(Date.now() + 10 * 60000).toISOString().slice(0, 16);
  await dialog
    .getByLabel("Authorization expires (UTC)", { exact: true })
    .fill(expires);
  await dialog.getByLabel("Repeat", { exact: true }).selectOption("advanced");
  await dialog.getByLabel("Recurrence JSON", { exact: true }).fill(
    JSON.stringify({
      kind: "once",
      at: new Date(Date.now() + 15000).toISOString(),
    }),
  );
  await dialog
    .getByLabel("Missed dates", { exact: true })
    .selectOption("latest");
  await assertEventually(
    () =>
      dialog
        .getByRole("button", { name: "Create schedule", exact: true })
        .isEnabled(),
    () => "Task inputs did not finish loading.",
  );
  await api(`projects/${project.id}`, "PATCH", {
    revision: 1,
    name: "Reviewed automation project",
    description: "",
  });
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Reload task settings", exact: true })
    .click();
  assert.match(
    await dialog.getByLabel("Objective", { exact: true }).inputValue(),
    /Implement scheduled marker/,
  );
  await dialog.getByLabel("Recurrence JSON", { exact: true }).fill(
    JSON.stringify({
      kind: "once",
      at: new Date(Date.now() + 15000).toISOString(),
    }),
  );
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  let schedule = (await api("schedules"))[0];
  assert.equal(schedule.action.kind, "run-task");
  assert.equal(schedule.enabled, false);
  assert.equal((await api("runs")).runs.length, 0);
  passed(
    "Task schedule creation preserves drafts through load failure and stale project recovery, and starts paused",
  );

  const card = page.getByRole("region", {
    name: "Scheduled implementation",
    exact: true,
  });
  await card
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog.getByText(/authorizes up to 1 more AI tasks/).waitFor();
  dropStatePath = `/api/v1/schedules/${schedule.id}/state`;
  await dialog
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  dropStatePath = null;
  await dialog
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  let history;
  await assertEventually(
    async () => {
      history = await api(`schedules/${schedule.id}/history`);
      return history.some((entry) => entry.runId);
    },
    () => `Task was not admitted. ${workflowWorker.logs()}`,
    35000,
  );
  const runId = history.find((entry) => entry.runId).runId;
  const queued = await api(`runs/${runId}`);
  assert.equal(queued.manifest.automation.scheduleId, schedule.id);
  assert.equal(queued.manifest.subject.kind, "project");
  assert.ok(
    Date.parse(queued.deadlineAt) <=
      Date.parse(queued.manifest.automation.expiresAt),
  );
  assert.equal((await api("runs")).runs.length, 1);
  assert.equal((await api(`schedules/${schedule.id}`)).reservedTokens, 100000);
  assert.equal(queued.manifest.profile.maxTokens, 100000);
  assert.equal((await api("execution-profiles")).profiles[0].maxTokens, 200000);
  passed(
    "Timed Temporal admission and a lost activation response produce one task and one token allocation",
  );

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await card.getByRole("button", { name: "History", exact: true }).click();
  await card.getByRole("link", { name: "queued", exact: true }).click();
  await page.waitForURL(`**/cloud/tasks/${runId}`);
  runner = await startRunnerProcess(
    fixture,
    worker,
    sandbox,
    "scheduled-runner",
  );
  assert.equal((await runner.finished)[0], 0, runner.logs());
  await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
  const complete = await api(`runs/${runId}`);
  assert.equal(complete.state, "succeeded");
  assert.equal((await api(`schedules/${schedule.id}`)).usedTokens, 320);
  assert.equal((await api(`schedules/${schedule.id}`)).reservedTokens, 0);
  assert.ok(complete.artifacts.some((entry) => entry.kind === "candidate"));
  const local = runnerHistory(runner);
  assert.equal(local.grant.runId, runId);
  assert.deepEqual(
    local.environments.map((environment) => environment.role),
    ["agent", "validation", "agent", "validation"],
  );
  assert.ok(
    local.environments.every(
      (environment) => environment.stopReceipt?.processTreeStopped,
    ),
  );
  await writeFile(
    join(fixture.directory, "scheduled-runner-history.json"),
    JSON.stringify(local, null, 2),
  );
  await page.screenshot({
    path: join(fixture.directory, "scheduled-task-complete.png"),
    fullPage: true,
  });
  passed(
    "The scheduled task completes through the real supervised WHPX sandbox, repair loop and protected validation",
  );

  await page.goto(`${fixture.origin}/cloud/schedules`);
  await card
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await dialog.getByLabel("Repeat", { exact: true }).selectOption("interval");
  await dialog.getByLabel("Interval (minutes)", { exact: true }).fill("1");
  await dialog
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await card
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "allowance is exhausted" })
    .waitFor();
  assert.equal((await api(`schedules/${schedule.id}`)).admittedRuns, 1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  passed(
    "Editing and reactivation cannot reset consumed task or token allowances",
  );

  const concurrent = await api("schedules", "POST", {
    name: "Concurrent admission",
    teamId: team.id,
    action: { ...schedule.action, maxRuns: 2, maxTokens: 400000 },
    recurrence: {
      kind: "interval",
      start: new Date(Date.now() - 3600000).toISOString(),
      everyMs: 60000,
    },
    missed: "bounded-all",
    catchUpLimit: 4,
    lookbackHours: 1,
  });
  await api(`schedules/${concurrent.id}/state`, "POST", {
    revision: 1,
    enabled: true,
  });
  await stopWorkflow();
  const state = await api(`schedules/${concurrent.id}`);
  await fixture.database.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [concurrent.id, state.nextAt - 20 * 60000],
  );
  await Promise.all([
    runtime.scheduleDispatcher.tick(),
    runtime.scheduleDispatcher.tick(),
  ]);
  const concurrentHistory = await api(`schedules/${concurrent.id}/history`);
  assert.equal(
    concurrentHistory.filter((entry) => entry.outcome === "admitted").length,
    1,
  );
  assert.equal(
    concurrentHistory.filter((entry) => entry.outcome === "overlap").length,
    3,
  );
  const currentRun = concurrentHistory.find((entry) => entry.runId).runId;
  await fixture.restart();
  await temporal.restart();
  await startWorkflow();
  assert.equal(
    (await api(`schedules/${concurrent.id}`)).reservedTokens,
    200000,
  );
  passed(
    "Concurrent dispatch and complete control-plane restart preserve one admission and skip overlapping occurrences",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.origin}/cloud/tasks/${currentRun}`);
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel task", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "canceled" }).waitFor();
  assert.equal((await api(`schedules/${concurrent.id}`)).reservedTokens, 0);
  await page.goto(`${fixture.origin}/cloud/schedules`);
  const concurrentCard = page.getByRole("region", {
    name: "Concurrent admission",
    exact: true,
  });
  await concurrentCard
    .getByRole("button", { name: "Pause schedule", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Pause schedule", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await concurrentCard
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Total token allowance", { exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "task-schedule-mobile.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "Mobile task cancellation releases unused reservations and the schedule editor fits the viewport",
  );
  const invited = await createPasswordInvitation(
    fixture,
    fixture.ownerContext,
    { email: "member@example.test", role: "member" },
  );
  const memberContext = await fixture.createContext();
  try {
    await acceptPasswordInvitation(fixture, memberContext, invited.url, {
      name: "Member",
      password: fixture.password,
    });
  } finally {
    await memberContext.close();
  }
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Stale account draft");
  await dialog
    .getByLabel("Issue title", { exact: true })
    .fill("Do not create under another account");
  await api("auth/login", "POST", {
    email: "member@example.test",
    password: fixture.password,
  });
  assert.equal((await api("workspace")).actor.name, "Member");
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "signed-in account changed" })
    .waitFor();
  assert.ok(
    !(await api("schedules")).some(
      (entry) => entry.name === "Stale account draft",
    ),
  );
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Stale account draft",
  );
  await page.keyboard.press("Escape");
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "A different account in another tab cannot publish a schedule from the stale page",
  );
  await writeFile(
    join(fixture.directory, "task-schedule-results.json"),
    JSON.stringify(
      {
        checks,
        pageErrors: fixture.pageErrors,
        runId,
        provider: "Controlled model responses; no live-provider inference",
        sandbox: "Native supervised WHPX Linux VM",
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "task-schedule-failure.png"),
      fullPage: true,
    })
    .catch((captureError) =>
      process.stderr.write(
        `Could not capture failure screenshot: ${captureError.message}\n`,
      ),
    );
  await writeFile(
    join(fixture.directory, "task-schedule-failure.json"),
    JSON.stringify(
      {
        message: String(error),
        checks,
        workflowLogs: workflowWorker?.logs(),
        runnerLogs: runner?.logs(),
        pageText: await page
          .locator("body")
          .innerText()
          .catch(() => "Page unavailable"),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (runner?.exitCode === null) runner.kill();
  await runner?.finished;
  await stopWorkflow();
  await temporal?.close();
  await database?.close();
  await fixture.close();
}
