import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, Connection } from "@temporalio/client";
import {
  cloudBrowserFixture,
  cloudApi,
  assertEventually,
} from "./cloud-browser-fixture.mjs";
import { cloudTemporalFixture } from "./cloud-temporal-fixture.mjs";
import { startCloudWorkflowWorker } from "./cloud-workflow-worker-fixture.mjs";
import { PostgresCloudDatabase } from "../src/server/cloud/database.ts";
import { createCloudRuntime } from "../src/server/cloud/runtime.ts";

let dropCreation = false;
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) => {
    if (dropCreation && path === "/api/v1/schedules" && status === 200) {
      return true;
    }
    return false;
  },
});
let temporal, worker, connection, database;
let stoppedWorkerLogs = "";
const workerLogs = () => worker?.logs() ?? stoppedWorkerLogs;
const checks = [];
const passed = (name) => {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
const api = (path, method, body, key) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body, key);
const page = await fixture.ownerContext.newPage();
const installationId = randomUUID();
const startWorker = () => {
  worker = startCloudWorkflowWorker(fixture, temporal, installationId);
};
const stopWorker = async () => {
  if (worker?.exitCode === null) worker.kill();
  await worker?.finished;
  stoppedWorkerLogs = worker?.logs() ?? stoppedWorkerLogs;
  worker = undefined;
};
const ready = () =>
  assertEventually(
    async () => {
      if (worker?.exitCode !== null)
        throw new Error(`Workflow worker exited. ${workerLogs()}`);
      return (await api("schedules/status")).available;
    },
    () => `Workflow worker did not become ready. ${workerLogs()}`,
    30000,
  );

try {
  await page.goto(`${fixture.origin}/cloud/login`);
  await page.getByLabel("Username or email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  const team = await api("teams", "POST", {
    name: "Schedules",
    key: "SC",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  database = new PostgresCloudDatabase(
    fixture.environment.MACHDOCH_CLOUD_DATABASE_URL,
  );
  const runtime = createCloudRuntime(database, fixture.origin);
  temporal = await cloudTemporalFixture(join(fixture.directory, "temporal"));
  startWorker();
  await ready();
  connection = await Connection.connect({ address: temporal.address });
  const temporalClient = new Client({
    connection,
    namespace: temporal.namespace,
  });
  const workflow = temporalClient.workflow.getHandle(
    `machdoch-cloud-${installationId}-schedules`,
  );
  const runId = (await workflow.describe()).runId;

  await page.goto(`${fixture.origin}/cloud/schedules`);
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Dependency review");
  await dialog
    .getByLabel("Issue title", { exact: true })
    .fill("Review dependencies");
  await dialog.locator("summary").filter({ hasText: "Issue options" }).click();
  await dialog.getByLabel("Priority", { exact: true }).selectOption("high");
  await dialog.getByLabel("Estimate", { exact: true }).selectOption("2");
  await dialog.locator("summary").filter({ hasText: "Issue options" }).click();
  await dialog.getByLabel("Repeat", { exact: true }).selectOption("daily");
  await dialog
    .getByLabel("Starts (UTC)", { exact: true })
    .fill("2026-01-01T00:00");
  await dialog.getByLabel("Timezone", { exact: true }).fill("Europe/Berlin");
  await dialog.getByLabel("Time", { exact: true }).fill("02:30");
  await page.route("**/api/v1/recurrence/preview", (route) =>
    route.continue({
      postData: JSON.stringify({
        ...route.request().postDataJSON(),
        after: "2026-10-24T22:00:00Z",
      }),
    }),
  );
  await dialog
    .getByRole("button", { name: "Preview dates", exact: true })
    .click();
  await dialog.getByRole("region", { name: "Upcoming dates" }).waitFor();
  assert.equal(
    await dialog.locator('time[datetime="2026-10-25T00:30:00.000Z"]').count(),
    1,
  );
  await dialog.getByLabel("Time", { exact: true }).fill("09:00");
  await dialog
    .getByRole("region", { name: "Upcoming dates" })
    .waitFor({ state: "hidden" });
  await page.unroute("**/api/v1/recurrence/preview");
  dropCreation = true;
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Dependency review",
  );
  dropCreation = false;
  await dialog
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  let schedule = (await api("schedules"))[0];
  assert.equal(schedule.enabled, false);
  assert.equal(schedule.action.issue.priority, "high");
  assert.equal(schedule.action.issue.estimate, "2");
  assert.equal((await api("schedules")).length, 1);
  assert.equal(
    (await api("issues")).issues?.length ?? (await api("issues")).length,
    0,
  );
  passed(
    "Structured creation, DST preview, obsolete-result clearing and duplicate-safe retry after a lost response",
  );

  let card = page.getByRole("region", {
    name: "Dependency review",
    exact: true,
  });
  await card
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  assert.equal(
    await dialog.getByLabel("Repeat", { exact: true }).inputValue(),
    "daily",
  );
  await dialog.getByLabel("Name", { exact: true }).fill("My draft");
  const external = {
    name: "Other editor",
    teamId: schedule.teamId,
    action: schedule.action,
    recurrence: schedule.recurrence,
    missed: schedule.missed,
    catchUpLimit: schedule.catchUpLimit,
    lookbackHours: schedule.lookbackHours,
    revision: schedule.revision,
  };
  await api(`schedules/${schedule.id}`, "PATCH", external);
  await dialog
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Load current version", exact: true })
    .waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "My draft",
  );
  await dialog
    .getByRole("button", { name: "Load current version", exact: true })
    .click();
  await assertEventually(
    async () =>
      (await dialog.getByLabel("Name", { exact: true }).inputValue()) ===
      "Other editor",
  );
  await dialog.getByLabel("Name", { exact: true }).fill("Dependency review");
  await dialog
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  passed(
    "Stale edits retain the draft and require explicit review before replacement",
  );

  const next = new Date(Date.now() + 15000).toISOString();
  const once = await api("schedules", "POST", {
    name: "Release review",
    teamId: team.id,
    action: {
      kind: "create-issue",
      issue: { teamId: team.id, title: "Review release" },
    },
    recurrence: { kind: "once", at: next },
    missed: "latest",
    catchUpLimit: 1,
    lookbackHours: 1,
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  card = page.getByRole("region", { name: "Release review", exact: true });
  await card
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await assertEventually(
    async () =>
      (await api(`schedules/${once.id}/history`)).some(
        (entry) => entry.outcome === "created",
      ),
    () => `Temporal did not dispatch the schedule. ${workerLogs()}`,
    35000,
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await card.getByRole("button", { name: "History", exact: true }).click();
  await card.getByRole("link", { name: /SC-/ }).click();
  await page.waitForURL(/\/cloud\/issues\/[a-f0-9-]+$/);
  assert.equal(
    await page.getByLabel("Title", { exact: true }).inputValue(),
    "Review release",
  );
  assert.equal(
    (await api(`schedules/${once.id}/history`)).filter(
      (entry) => entry.outcome === "created",
    ).length,
    1,
  );
  passed(
    "The production Temporal worker creates one scheduled issue, with a browser history link",
  );

  const recurring = await api("schedules", "POST", {
    name: "Catch-up",
    teamId: team.id,
    action: {
      kind: "create-issue",
      issue: { teamId: team.id, title: "Catch-up issue" },
    },
    recurrence: {
      kind: "interval",
      start: new Date(Date.now() - 3600000).toISOString(),
      everyMs: 60000,
    },
    missed: "bounded-all",
    catchUpLimit: 3,
    lookbackHours: 1,
  });
  await api(`schedules/${recurring.id}/state`, "POST", {
    revision: 1,
    enabled: true,
  });
  await stopWorker();
  const nextAt = (await api(`schedules/${recurring.id}`)).nextAt - 20 * 60000;
  await fixture.database.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [recurring.id, nextAt],
  );
  await Promise.all([
    runtime.scheduleDispatcher.tick(),
    runtime.scheduleDispatcher.tick(),
  ]);
  assert.equal(
    (await api(`schedules/${recurring.id}/history`)).filter(
      (entry) => entry.outcome === "created",
    ).length,
    3,
  );
  const recovery = await api("schedules", "POST", {
    name: "Recovery",
    teamId: team.id,
    action: {
      kind: "create-issue",
      issue: { teamId: team.id, title: "Recovered occurrence" },
    },
    recurrence: {
      kind: "once",
      at: new Date(Date.now() + 10000).toISOString(),
    },
    missed: "latest",
    catchUpLimit: 1,
    lookbackHours: 1,
  });
  await api(`schedules/${recovery.id}/state`, "POST", {
    revision: 1,
    enabled: true,
  });
  await fixture.restart();
  await connection.close();
  connection = undefined;
  await temporal.restart();
  startWorker();
  await ready();
  connection = await Connection.connect({ address: temporal.address });
  const resumed = new Client({ connection, namespace: temporal.namespace });
  assert.equal(
    (
      await resumed.workflow
        .getHandle(`machdoch-cloud-${installationId}-schedules`)
        .describe()
    ).runId,
    runId,
  );
  await assertEventually(
    async () =>
      (await api(`schedules/${recovery.id}/history`)).filter(
        (entry) => entry.outcome === "created",
      ).length === 1,
    () => `Restarted worker did not resume dispatch. ${workerLogs()}`,
    30000,
  );
  assert.equal(
    (await api(`schedules/${recurring.id}/history`)).filter(
      (entry) => entry.outcome === "created",
    ).length,
    3,
  );
  passed(
    "Concurrent PostgreSQL dispatch is duplicate-safe; server and Temporal restart retain the workflow and receipts",
  );

  await stopWorker();
  const stopped = await api(`schedules/${recurring.id}`);
  await api(`schedules/${recurring.id}/state`, "POST", {
    revision: stopped.revision,
    enabled: false,
  });
  await fixture.database.query(
    "UPDATE cloud_schedule_worker SET touched_at=clock_timestamp()-interval '1 minute'",
  );
  await page.goto(`${fixture.origin}/cloud/schedules`);
  card = page.getByRole("region", { name: "Catch-up", exact: true });
  await card
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enable schedule", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "schedule worker is unavailable" })
    .waitFor();
  assert.equal((await api(`schedules/${recurring.id}`)).enabled, false);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  passed(
    "An unavailable worker leaves the schedule paused and explains how to retry",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Repeat", { exact: true })
    .selectOption("cron");
  await page
    .getByRole("dialog")
    .getByLabel("Cron expression", { exact: true })
    .fill("invalid");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Preview dates", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await assertEventually(
    async () => {
      const error = await page
        .getByRole("dialog")
        .getByRole("alert")
        .boundingBox();
      const footer = await page
        .getByRole("dialog")
        .locator(".fleet-dialog-footer")
        .boundingBox();
      return error && footer && error.y + error.height <= footer.y;
    },
    () => "The preview error is obscured by the dialog footer.",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "schedule-mobile.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await assertEventually(
    async () =>
      page
        .getByRole("button", { name: "New schedule", exact: true })
        .evaluate((element) => element === document.activeElement),
    () => "Closing the schedule editor did not return focus to its opener.",
  );
  assert.deepEqual(fixture.pageErrors, []);
  passed("Mobile validation, keyboard dismissal and focus restoration");

  await writeFile(
    join(fixture.directory, "schedule-results.json"),
    JSON.stringify(
      {
        checks,
        temporal: "1.32.1 production binary, isolated SQLite persistence",
        database: "PostgreSQL isolated schema",
        workflowRunId: runId,
        pageErrors: fixture.pageErrors,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await writeFile(
    join(fixture.directory, "schedule-failure.json"),
    JSON.stringify(
      { message: String(error), checks, workerLogs: workerLogs() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await stopWorker();
  await connection?.close();
  await temporal?.close();
  await database?.close();
  await fixture.close();
}
