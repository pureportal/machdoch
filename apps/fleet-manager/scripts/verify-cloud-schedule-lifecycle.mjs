import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { RunnerConnection } from "@machdoch/cloud-client";
import {
  cloudBrowserFixture,
  cloudApi,
  assertEventually,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";
import { cloudTemporalFixture } from "./cloud-temporal-fixture.mjs";
import { startCloudWorkflowWorker } from "./cloud-workflow-worker-fixture.mjs";
import { PostgresCloudDatabase } from "../src/server/cloud/database.ts";
import { createCloudRuntime } from "../src/server/cloud/runtime.ts";

let droppedPath = null;
const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-schedule-fixture.ts",
  dropResponse: ({ path, status }) => path === droppedPath && status === 200,
});
const certificates = getCACertificates("default");
const api = (path, method, data, key) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data, key);
const checks = [],
  page = await fixture.ownerContext.newPage();
const passed = (name) => {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
let temporal, workflowWorker, database;
const installationId = randomUUID();
async function stopWorkflow() {
  if (workflowWorker?.exitCode === null) workflowWorker.kill();
  await workflowWorker?.finished;
  workflowWorker = undefined;
}
async function startWorkflow() {
  workflowWorker = startCloudWorkflowWorker(fixture, temporal, installationId);
  await assertEventually(
    async () => {
      if (workflowWorker.exitCode !== null)
        throw new Error(workflowWorker.logs());
      return (await api("schedules/status")).available;
    },
    () => `Workflow worker did not become ready. ${workflowWorker.logs()}`,
    30000,
  );
}
try {
  setDefaultCACertificates([
    ...certificates,
    await readFile(join(fixture.directory, "tls.crt"), "utf8"),
  ]);
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const workspace = await api("workspace");
  const team = await api("teams", "POST", {
    name: "Lifecycle",
    key: "LC",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    name: "Lifecycle",
    teamId: team.id,
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    name: "Reports",
    projectId: project.id,
    target: "cloud",
    repository: "https://github.com/example/project",
    baseCommit: "a".repeat(40),
    providerId: provider.id,
    model: "fixture",
    maxTokens: 10000,
    maxDurationSeconds: 300,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 30 },
    ],
  });
  const worker = await api("execution-workers", "POST", {
    name: "Protocol fixture",
    profileId: profile.id,
  });
  const connection = new RunnerConnection(fixture.origin, worker.token);
  temporal = await cloudTemporalFixture(join(fixture.directory, "temporal"));
  await startWorkflow();
  database = new PostgresCloudDatabase(
    fixture.environment.MACHDOCH_CLOUD_DATABASE_URL,
  );
  const runtime = createCloudRuntime(database, fixture.origin);
  await page.goto(`${fixture.origin}/cloud/schedules`);
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Completion report");
  await dialog.getByLabel("Action", { exact: true }).selectOption("run-task");
  await dialog
    .getByLabel("Execution profile", { exact: true })
    .selectOption(profile.id);
  await dialog
    .getByLabel("Objective", { exact: true })
    .fill("Create a completion report");
  await dialog
    .getByLabel("Acceptance criteria", { exact: true })
    .fill("Include the evidence");
  await dialog.getByLabel("Maximum tasks", { exact: true }).fill("3");
  await dialog
    .getByLabel("Total token allowance", { exact: true })
    .fill("10000");
  await dialog
    .getByLabel("Repeat", { exact: true })
    .selectOption("fixed-delay");
  await dialog.getByLabel("Delay (minutes)", { exact: true }).fill("1");
  const previewStart = (
    await fixture.database.query(
      "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now",
    )
  ).rows[0].now;
  await dialog
    .getByRole("button", { name: "Preview dates", exact: true })
    .click();
  const dates = dialog.getByRole("region", { name: "Upcoming dates" });
  await dates.waitFor();
  assert.equal(await dates.locator("time").count(), 1);
  const initialDate = Date.parse(
    await dates.locator("time").getAttribute("datetime"),
  );
  assert.ok(initialDate >= previewStart + 60000);
  assert.equal(
    await dialog
      .getByLabel("Missed dates", { exact: true })
      .locator('option[value="latest"]')
      .textContent(),
    "Run the latest task",
  );
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  const primary = (await api("schedules"))[0];
  let card = page.getByRole("region", {
    name: "Completion report",
    exact: true,
  });
  await card
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  const enabled = await api(`schedules/${primary.id}`);
  await fixture.database.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [primary.id, enabled.nextAt - 60000],
  );
  await assertEventually(
    async () => (await api(`schedules/${primary.id}`)).waitingRunId !== null,
  );
  const claim = (await connection.claim(randomUUID())).claim;
  assert.ok(claim);
  await connection.command("accept", {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    environmentId: randomUUID(),
    baseCommit: claim.manifest.profile.baseCommit,
    isolation: "microvm",
  });
  const requestId = randomUUID();
  const identity = {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    requestId,
  };
  await connection.command("inference", {
    ...identity,
    context: "{}",
    runtimePrompt: "",
    tools: [],
    modelOptions: {},
  });
  await assertEventually(
    async () =>
      (await connection.command("inference/result", identity)).state ===
      "complete",
  );
  const active = await api(`schedules/${primary.id}`);
  assert.equal(active.nextAt, null);
  assert.equal(active.usedTokens, 250);
  assert.equal(active.reservedTokens, 9750);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await card.getByText("Waiting for task", { exact: true }).waitFor();
  await card.getByText(/250 of .* tokens used/).waitFor();
  await connection.heartbeat(claim);
  await card
    .getByRole("button", { name: "Pause schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Pause schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await card
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Preview dates", exact: true })
    .click();
  await dialog
    .getByText("The first date will be set after the current task finishes.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("region", { name: "Upcoming dates" })
      .locator("time")
      .count(),
    0,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await card
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  passed(
    "Structured completion-based schedules wait for their active task and show measured and reserved tokens",
  );

  await connection.heartbeat(claim);
  await stopWorkflow();
  await fixture.restart();
  await temporal.restart();
  await startWorkflow();
  assert.equal(
    (await api(`schedules/${primary.id}`)).waitingRunId,
    claim.runId,
  );
  assert.equal((await api("runs")).runs.length, 1);
  await connection.heartbeat(claim);
  const running = await api(`runs/${claim.runId}`);
  await api(`runs/${claim.runId}/cancel`, "POST", {
    revision: running.revision,
  });
  await fixture.database.query(
    "UPDATE cloud_schedules SET maintenance_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [primary.id],
  );
  await runtime.scheduleDispatcher.tick();
  assert.equal((await api(`schedules/${primary.id}`)).nextAt, null);
  await connection.finish({
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
    outcome: "canceled",
    summary: "Protocol fixture stopped",
    stopped: true,
    candidateCommit: null,
    tokensUsed: 9999,
    checks: [],
  });
  await assertEventually(
    async () => (await api(`schedules/${primary.id}`)).nextAt !== null,
  );
  const resumed = await api(`schedules/${primary.id}`);
  const firstHistory = (await api(`schedules/${primary.id}/history`))[0];
  assert.equal(resumed.nextAt, firstHistory.completedAt + 60000);
  assert.equal(resumed.usedTokens, 250);
  assert.equal(resumed.reservedTokens, 0);
  passed(
    "Restart preserves the completion wait; cancellation requests alone do not advance it, and a confirmed stop releases unused tokens",
  );

  await fixture.database.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [primary.id, resumed.nextAt - 60000],
  );
  await assertEventually(
    async () => (await api(`schedules/${primary.id}`)).admittedRuns === 2,
  );
  const secondId = (await api(`schedules/${primary.id}`)).waitingRunId;
  assert.equal(
    (await api(`runs/${secondId}`)).manifest.profile.maxTokens,
    9750,
  );
  assert.equal((await api("execution-profiles")).profiles[0].maxTokens, 10000);
  const current = await api(`schedules/${primary.id}`);
  await api(`schedules/${primary.id}/state`, "POST", {
    revision: current.revision,
    enabled: false,
  });
  const second = await api(`runs/${secondId}`);
  await api(`runs/${secondId}/cancel`, "POST", { revision: second.revision });
  assert.equal((await api(`schedules/${primary.id}`)).reservedTokens, 0);
  passed(
    "The next task receives only the remaining token allowance; canceling an unsent task returns its reservation",
  );

  const unknown = await api("schedules", "POST", {
    name: "Unknown usage",
    teamId: team.id,
    action: {
      kind: "run-task",
      run: {
        profileId: profile.id,
        subject: {
          kind: "project",
          id: project.id,
          revision: 1,
          purpose: "research",
          objective: "Unknown usage",
          acceptanceCriteria: "Record evidence",
        },
      },
      profileRevision: 1,
      maxRuns: 1,
      maxTokens: 5000,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    recurrence: {
      kind: "interval",
      start: new Date(Date.now() - 3600000).toISOString(),
      everyMs: 60000,
    },
    missed: "latest",
    catchUpLimit: 1,
    lookbackHours: 1,
  });
  await api(`schedules/${unknown.id}/state`, "POST", {
    revision: 1,
    enabled: true,
  });
  const unknownState = await api(`schedules/${unknown.id}`);
  await fixture.database.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [unknown.id, unknownState.nextAt - 60000],
  );
  await assertEventually(
    async () => (await api(`schedules/${unknown.id}`)).admittedRuns === 1,
  );
  const uncertainClaim = (await connection.claim(randomUUID())).claim;
  assert.ok(uncertainClaim);
  await connection.command("accept", {
    runId: uncertainClaim.runId,
    attemptId: uncertainClaim.attemptId,
    epoch: uncertainClaim.epoch,
    environmentId: randomUUID(),
    baseCommit: uncertainClaim.manifest.profile.baseCommit,
    isolation: "microvm",
  });
  const uncertainRequest = randomUUID(),
    uncertainIdentity = {
      runId: uncertainClaim.runId,
      attemptId: uncertainClaim.attemptId,
      epoch: uncertainClaim.epoch,
      requestId: uncertainRequest,
    };
  await connection.command("inference", {
    ...uncertainIdentity,
    context: "{}",
    runtimePrompt: "",
    tools: [],
    modelOptions: {},
  });
  await assertEventually(
    async () =>
      (await connection.command("inference/result", uncertainIdentity))
        .state === "failed",
  );
  await connection.finish({
    runId: uncertainClaim.runId,
    attemptId: uncertainClaim.attemptId,
    epoch: uncertainClaim.epoch,
    inputDigest: uncertainClaim.inputDigest,
    outcome: "failed",
    summary: "Provider outcome unconfirmed",
    stopped: true,
    candidateCommit: null,
    tokensUsed: 0,
    checks: [],
  });
  const held = await api(`schedules/${unknown.id}`);
  assert.equal(held.usedTokens, 0);
  assert.ok(held.reservedTokens > 0 && held.reservedTokens < 5000);
  await page.goto(`${fixture.origin}/cloud/schedules`);
  card = page.getByRole("region", { name: "Unknown usage", exact: true });
  await card.getByRole("button", { name: "History", exact: true }).click();
  await card.getByText(/usage unconfirmed/).waitFor();
  passed(
    "Uncertain provider usage remains reserved and is visible in task history after execution stops",
  );

  await card
    .getByRole("button", { name: "Archive schedule", exact: true })
    .click();
  droppedPath = `/api/v1/schedules/${unknown.id}/archive`;
  await dialog
    .getByRole("button", { name: "Archive schedule", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  droppedPath = null;
  await dialog
    .getByRole("button", { name: "Archive schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await card.waitFor({ state: "hidden" });
  await assertEventually(() =>
    page
      .getByRole("heading", { name: "Schedules", exact: true })
      .evaluate((element) => element === document.activeElement),
  );
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await card.waitFor();
  const call = (
    await fixture.database.query(
      "SELECT execution_id FROM cloud_inference_calls WHERE id=$1",
      [uncertainRequest],
    )
  ).rows[0];
  await runtime.inference.store.finish(
    workspace.organization.id,
    uncertainRequest,
    call.execution_id,
    {
      state: "complete",
      tokens: 125,
      answer: "Late measured receipt",
      errorCode: null,
    },
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await card.getByText(/125 of .* tokens used/).waitFor();
  const settled = await api(`schedules/${unknown.id}`);
  assert.equal(settled.reservedTokens, 0);
  assert.equal(settled.usedTokens, 125);
  await card
    .getByRole("button", { name: "Restore schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Restore schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await card.getByText("Paused", { exact: true }).waitFor();
  assert.equal((await api(`schedules/${unknown.id}`)).enabled, false);
  passed(
    "Archive retries are duplicate-safe, late usage settles while archived, and restore keeps the schedule paused",
  );

  const restored = await api(`schedules/${unknown.id}`),
    base = Date.now() - 500000;
  await fixture.database.query(
    "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome,reason) SELECT $1,$2,$3,$4::bigint+n,$4::bigint+n,'skipped','Earlier occurrence '||n FROM generate_series(1,205) n",
    [workspace.organization.id, unknown.id, restored.revision, base],
  );
  await card.getByRole("button", { name: "History", exact: true }).click();
  await card.getByRole("button", { name: "Load earlier", exact: true }).click();
  await assertEventually(
    async () =>
      (await card.getByText(/^Earlier occurrence \d+$/).count()) === 199,
  );
  await card.getByRole("button", { name: "Load earlier", exact: true }).click();
  await assertEventually(
    async () =>
      (await card.getByText(/^Earlier occurrence \d+$/).count()) === 205,
  );
  await card
    .getByRole("button", { name: "Load earlier", exact: true })
    .waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByRole("button", { name: "History", exact: true }).click();
  await card
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await dialog
    .getByLabel("Repeat", { exact: true })
    .selectOption("fixed-delay");
  await dialog
    .getByLabel("Delay (minutes)", { exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "schedule-lifecycle-mobile.png"),
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "History pagination retrieves earlier receipts without omissions and lifecycle controls fit the mobile viewport",
  );
  await writeFile(
    join(fixture.directory, "schedule-lifecycle-results.json"),
    JSON.stringify(
      {
        checks,
        pageErrors: fixture.pageErrors,
        worker: "Protocol fixture; no sandbox process",
        inference:
          "Controlled provider factory with measured and uncertain outcomes",
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "schedule-lifecycle-failure.png"),
      fullPage: true,
    })
    .catch((reason) =>
      process.stderr.write(`Screenshot failed: ${reason.message}\n`),
    );
  await writeFile(
    join(fixture.directory, "schedule-lifecycle-failure.json"),
    JSON.stringify(
      {
        message: String(error),
        checks,
        pageText: await page
          .locator("body")
          .innerText()
          .catch(() => "Page unavailable"),
        workerLogs: workflowWorker?.logs(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await stopWorkflow();
  await temporal?.close();
  await database?.close();
  setDefaultCACertificates(certificates);
  await fixture.close();
}
