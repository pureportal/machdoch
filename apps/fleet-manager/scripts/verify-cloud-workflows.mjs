import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudApi,
  cloudBrowserFixture,
  createPasswordInvitation,
  acceptPasswordInvitation,
  executionProviderFixture,
  assertEventually,
} from "./cloud-browser-fixture.mjs";
import { cloudTemporalFixture } from "./cloud-temporal-fixture.mjs";
import { startCloudWorkflowWorker } from "./cloud-workflow-worker-fixture.mjs";

let dropPath = "";
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) => path === dropPath && status === 200,
});
const page = await fixture.ownerContext.newPage(),
  other = await fixture.ownerContext.newPage();
const memberContext = await fixture.createContext(),
  member = await memberContext.newPage();
const api = (path, method, body, key) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body, key);
const checks = [];
const passed = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let temporal, worker;
async function raw(path, method, data) {
  const csrf = (await fixture.ownerContext.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  return fixture.ownerContext.request.fetch(
    `${fixture.origin}/api/v1/${path}`,
    {
      method,
      headers: {
        Origin: fixture.origin,
        "x-machdoch-cloud-csrf": csrf,
        "Idempotency-Key": randomUUID(),
      },
      data,
    },
  );
}
function definition(workflow) {
  return {
    revision: workflow.revision,
    defaultStatusId: workflow.defaultStatusId,
    statuses: workflow.statuses.map(({ revision: _, ...status }) => status),
  };
}
async function editIssue(id, patch) {
  const current = await api(`issues/${id}`);
  const {
    id: _id,
    teamId: _team,
    identifier: _key,
    updatedAt: _time,
    state: _state,
    statusName: _name,
    estimatePoints: _points,
    ...input
  } = current;
  await api(`issues/${id}`, "PATCH", { ...input, ...patch });
}
async function openWorkflow(target, teamId) {
  await target.goto(`${fixture.origin}/cloud/teams`);
  await target
    .locator(`#planning-${teamId}`)
    .getByRole("button", { name: "Workflow", exact: true })
    .click();
  const dialog = target.getByRole("dialog", {
    name: "Team workflow",
    exact: true,
  });
  await dialog.getByLabel("Default status", { exact: true }).waitFor();
  return dialog;
}
function statusRow(dialog, id) {
  return dialog.locator(
    `fieldset[aria-label^="Status "]:has(#status-name-${id})`,
  );
}

try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const invitation = await createPasswordInvitation(
    fixture,
    fixture.ownerContext,
    { email: "member@example.test", role: "member" },
  );
  await acceptPasswordInvitation(fixture, memberContext, invitation.url, {
    name: "Member",
    password: fixture.password,
  });
  await cloudApi(fixture, memberContext, "auth/login", "POST", {
    email: "member@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Delivery",
    key: "DV",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  let current = await api(`teams/${team.id}/workflow`);
  const ready = current.statuses.find((status) => status.category === "ready");
  const backlog = current.statuses.find(
    (status) => status.category === "backlog",
  );
  await member.goto(`${fixture.origin}/cloud/teams`);
  assert.equal(
    await member.getByRole("button", { name: "Workflow", exact: true }).count(),
    0,
  );
  assert.equal(
    (await cloudApi(fixture, memberContext, `teams/${team.id}/workflow`))
      .statuses.length,
    7,
  );

  let dialog = await openWorkflow(page, team.id);
  await dialog.getByRole("button", { name: "Add status", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Remove new status untitled", exact: true })
    .click();
  assert.equal(
    await dialog.locator('fieldset[aria-label^="Status "]').count(),
    7,
  );
  await dialog.getByRole("button", { name: "Add status", exact: true }).click();
  const added = dialog.getByRole("group", { name: "Status 8", exact: true });
  await added.getByLabel("Name", { exact: true }).fill("Quality gate");
  await added.getByLabel("Category", { exact: true }).selectOption("review");
  await dialog
    .getByLabel("Default status", { exact: true })
    .selectOption({ label: "Quality gate" });
  dropPath = `/api/v1/teams/${team.id}/workflow`;
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  assert.equal(
    await added.getByLabel("Name", { exact: true }).inputValue(),
    "Quality gate",
  );
  dropPath = "";
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  current = await api(`teams/${team.id}/workflow`);
  const quality = current.statuses.find(
    (status) => status.name === "Quality gate",
  );
  assert.equal(current.revision, 2);
  assert.equal(current.statuses.length, 8);
  assert.equal(current.defaultStatusId, quality.id);
  passed(
    "Administrators configure custom statuses and defaults; lost responses retry without duplicate changes or lost drafts",
  );

  await page.goto(`${fixture.origin}/cloud/issues?teamId=${team.id}`);
  await page.getByRole("button", { name: "New issue", exact: true }).click();
  let issueForm = page.getByRole("dialog", { name: "New issue", exact: true });
  await issueForm
    .getByLabel("Title", { exact: true })
    .fill("First custom workflow issue");
  await issueForm
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await page.waitForURL(/\/cloud\/issues\/[^/]+$/);
  assert.equal(
    JSON.parse(await page.getByLabel("Status", { exact: true }).inputValue())
      .id,
    quality.id,
  );
  const first = (await api(`issues?teamId=${team.id}`)).issues[0];
  assert.equal(first.state, "review");
  await page
    .getByLabel("Status", { exact: true })
    .selectOption({ label: "Ready" });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  await page.goto(
    `${fixture.origin}/cloud/issues?teamId=${team.id}&view=board`,
  );
  await page
    .getByRole("region", { name: "Ready", exact: true })
    .getByRole("link", { name: /First custom workflow issue/ })
    .waitFor();
  await page
    .getByRole("region", { name: "Quality gate", exact: true })
    .waitFor();
  await page.getByLabel("Filter by status").selectOption(ready.id);
  await page.waitForURL(new RegExp(`statusId=${ready.id}`));
  assert.equal((await api(`issues?statusId=${ready.id}`)).issues.length, 1);
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await page.getByRole("cell", { name: "Ready", exact: true }).waitFor();
  passed(
    "Issue creation uses the team default; custom statuses integrate with editing, ordered boards and status filters",
  );

  dialog = await openWorkflow(page, team.id);
  const newer = await openWorkflow(other, team.id);
  await statusRow(dialog, quality.id)
    .getByLabel("Name", { exact: true })
    .fill("Unpublished draft");
  await statusRow(newer, backlog.id)
    .getByLabel("Name", { exact: true })
    .fill("Triage");
  await newer
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await newer.waitFor({ state: "hidden" });
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog
    .getByRole("region", { name: "Latest workflow" })
    .getByText(/Triage/)
    .waitFor();
  assert.equal(
    await statusRow(dialog, quality.id)
      .getByLabel("Name", { exact: true })
      .inputValue(),
    "Unpublished draft",
  );
  await dialog
    .getByRole("button", { name: "Reload workflow", exact: true })
    .click();
  assert.equal(
    await statusRow(dialog, quality.id)
      .getByLabel("Name", { exact: true })
      .inputValue(),
    "Quality gate",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  passed(
    "Concurrent workflow editors preserve the draft and require an explicit reload after a revision conflict",
  );

  temporal = await cloudTemporalFixture(join(fixture.directory, "temporal"));
  worker = startCloudWorkflowWorker(fixture, temporal, randomUUID());
  await assertEventually(
    async () => {
      if (worker.exitCode !== null) throw new Error(worker.logs());
      return (await api("schedules/status")).available;
    },
    () => `Workflow worker unavailable: ${worker.logs()}`,
    30000,
  );
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Workflow project",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Workflow tasks",
    target: "cloud",
    repository: "https://github.com/example/project",
    baseCommit: "a".repeat(40),
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 3600,
    maxTokens: 10000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  const cycle = await api("cycles", "POST", {
    teamId: team.id,
    name: "Workflow cycle",
    startsOn: "2026-10-01",
    endsOn: "2026-11-01",
    timezone: "UTC",
    capacity: 10,
  });
  const subject = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    cycleId: cycle.id,
    title: "Review the implementation",
    acceptanceCriteria: "Checks pass",
    status: { id: quality.id, revision: quality.revision },
  });
  await api(`cycles/${cycle.id}/commands`, "POST", {
    kind: "start",
    revision: 1,
  });
  await api(`cycles/${cycle.id}/commands`, "POST", {
    kind: "close",
    revision: 2,
    carryoverCycleId: null,
  });
  const closed = await api(`cycles/${cycle.id}`);
  const issue = await api(`issues/${subject.id}`);
  const run = await api("runs", "POST", {
    profileId: profile.id,
    subject: { kind: "issue", id: subject.id, revision: issue.revision },
  });
  const originalRun = await api(`runs/${run.id}`);
  const scheduled = await api("schedules", "POST", {
    name: "Workflow recurring issue",
    teamId: team.id,
    action: {
      kind: "create-issue",
      issue: {
        teamId: team.id,
        title: "Recurring quality review",
        status: { id: quality.id, revision: quality.revision },
      },
    },
    recurrence: {
      kind: "interval",
      start: new Date(Date.now() + 3600000).toISOString(),
      everyMs: 60000,
    },
    missed: "skip",
    catchUpLimit: 1,
    lookbackHours: 1,
  });
  await api(`schedules/${scheduled.id}/state`, "POST", {
    revision: 1,
    enabled: true,
  });
  dialog = await openWorkflow(page, team.id);
  await dialog
    .getByLabel("Default status", { exact: true })
    .selectOption(ready.id);
  await statusRow(dialog, quality.id)
    .getByLabel("Name", { exact: true })
    .fill("Verified");
  await statusRow(dialog, quality.id)
    .getByLabel("Category", { exact: true })
    .selectOption("complete");
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  const impact = dialog.getByRole("region", {
    name: "Workflow impact",
    exact: true,
  });
  await impact
    .getByText("1 issue changes category.", { exact: true })
    .waitFor();
  await impact.getByText("1 schedule pauses.", { exact: true }).waitFor();
  await impact.getByText(/1 active task keeps/).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Save workflow", exact: true })
      .isDisabled(),
    true,
  );
  await editIssue(subject.id, {
    description: "Changed while impact was being reviewed",
  });
  await impact.getByLabel("Apply these changes", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "affected planning changed" })
    .waitFor();
  assert.equal(
    await impact.getByLabel("Apply these changes", { exact: true }).isChecked(),
    false,
  );
  assert.equal((await api(`issues/${subject.id}`)).state, "review");
  await impact.getByLabel("Apply these changes", { exact: true }).check();
  dropPath = `/api/v1/teams/${team.id}/workflow`;
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  dropPath = "";
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await api(`issues/${subject.id}`)).state, "complete");
  const paused = await api(`schedules/${scheduled.id}`);
  assert.equal(paused.enabled, false);
  assert.match(paused.error, /workflow changed/);
  assert.deepEqual(await api(`cycles/${cycle.id}`), closed);
  const changedRun = await api(`runs/${run.id}`);
  assert.equal(changedRun.contextChanged, true);
  assert.equal(changedRun.state, "queued");
  assert.deepEqual(changedRun.manifest, originalRun.manifest);
  assert.equal(changedRun.inputDigest, originalRun.inputDigest);
  passed(
    "Impact review detects intervening edits, pauses schedules and preserves cycle/run snapshots across recategorization and a lost response",
  );

  await page.goto(`${fixture.origin}/cloud/issues/${subject.id}`);
  assert.equal(
    await page.getByRole("button", { name: "New task", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("region", {
    name: "Issue history",
    exact: true,
  });
  await history.getByText(/Verified/).waitFor();
  await history
    .getByText(/Quality gate/)
    .first()
    .waitFor();
  await page.goto(`${fixture.origin}/cloud/cycles/${cycle.id}`);
  await page.getByRole("cell", { name: "Quality gate", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("cell", { name: "Verified", exact: true }).count(),
    0,
  );
  passed(
    "Issue history retains captured status names, completed cycles retain closing labels, and closed issues offer no new implementation task",
  );

  await page.goto(`${fixture.origin}/cloud/schedules`);
  const card = page.getByRole("region", {
    name: "Workflow recurring issue",
    exact: true,
  });
  await card
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  let scheduleDialog = page.getByRole("dialog", {
    name: "Edit schedule",
    exact: true,
  });
  await scheduleDialog
    .getByLabel("Name", { exact: true })
    .fill("Reviewed recurring issue");
  await scheduleDialog
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await scheduleDialog
    .getByRole("button", { name: "Reload statuses", exact: true })
    .click();
  await scheduleDialog
    .getByLabel("Status", { exact: true })
    .selectOption({ label: "Ready" });
  assert.equal(
    await scheduleDialog.getByLabel("Name", { exact: true }).inputValue(),
    "Reviewed recurring issue",
  );
  await scheduleDialog
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await scheduleDialog.waitFor({ state: "hidden" });
  const reviewed = await api(`schedules/${scheduled.id}`);
  assert.equal(reviewed.enabled, false);
  assert.equal(reviewed.action.issue.status.id, ready.id);
  await api(`schedules/${scheduled.id}`, "PATCH", {
    revision: reviewed.revision,
    name: reviewed.name,
    teamId: team.id,
    action: reviewed.action,
    recurrence: {
      kind: "once",
      at: new Date(Date.now() + 15000).toISOString(),
    },
    missed: "latest",
    catchUpLimit: 1,
    lookbackHours: 1,
  });
  const activated = await api(`schedules/${scheduled.id}`);
  await api(`schedules/${scheduled.id}/state`, "POST", {
    revision: activated.revision,
    enabled: true,
  });
  passed(
    "A stale scheduled status requires reloading and reselecting a status while retaining the user's other edits",
  );

  dialog = await openWorkflow(page, team.id);
  await statusRow(dialog, quality.id)
    .getByLabel("Archived", { exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  const archivedWorkflow = await api(`teams/${team.id}/workflow`);
  const archivedStatus = archivedWorkflow.statuses.find(
    (status) => status.id === quality.id,
  );
  const rejected = await raw("issues", "POST", {
    teamId: team.id,
    title: "Archived assignment",
    status: { id: quality.id, revision: archivedStatus.revision },
  });
  assert.equal(rejected.status(), 409);
  assert.equal((await rejected.json()).code, "status_archived");
  await page.goto(`${fixture.origin}/cloud/issues/${subject.id}`);
  await page
    .getByLabel("Title", { exact: true })
    .fill("Keep archived status assignment");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  assert.equal((await api(`issues/${subject.id}`)).status.id, quality.id);
  dialog = await openWorkflow(page, team.id);
  await dialog
    .getByRole("button", { name: "Show archived", exact: true })
    .click();
  await statusRow(dialog, quality.id)
    .getByLabel("Archived", { exact: true })
    .uncheck();
  await dialog
    .getByRole("button", { name: "Move Verified up", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(fixture.directory, "workflow-mobile.png"),
  });
  await dialog
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await api(`teams/${team.id}/workflow`)).statuses[6].id,
    quality.id,
  );
  passed(
    "Archived statuses retain existing assignments, reject new assignments, restore with fresh authority and reorder on mobile",
  );

  await fixture.restart();
  await assertEventually(
    async () =>
      (await api(`schedules/${scheduled.id}/history`)).some(
        (entry) => entry.outcome === "created",
      ),
    () => `Reviewed schedule did not execute: ${worker.logs()}`,
    30000,
  );
  const occurrence = (await api(`schedules/${scheduled.id}/history`)).find(
    (entry) => entry.outcome === "created",
  );
  const recurringIssue = await api(`issues/${occurrence.issueId}`);
  assert.equal(recurringIssue.status.id, ready.id);
  assert.equal(recurringIssue.state, "ready");
  assert.equal(
    (await api(`teams/${team.id}/workflow`)).statuses[6].id,
    quality.id,
  );
  assert.deepEqual(await api(`cycles/${cycle.id}`), closed);
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "The production coordinator creates the reviewed status after an application restart, with workflow order and frozen history intact",
  );
  const beforeRace = await api(`teams/${team.id}/workflow`);
  const contenders = ["Intake one", "Intake two"].map((name) => {
    const next = definition(beforeRace);
    next.statuses.find((status) => status.id === backlog.id).name = name;
    return next;
  });
  const previews = await Promise.all(
    contenders.map((candidate) =>
      api(`teams/${team.id}/workflow/preview`, "POST", candidate),
    ),
  );
  const raced = await Promise.all(
    contenders.map((candidate, index) =>
      raw(`teams/${team.id}/workflow`, "PATCH", {
        definition: candidate,
        impactDigest: previews[index].digest,
      }),
    ),
  );
  assert.deepEqual(
    raced.map((response) => response.status()).sort((a, b) => a - b),
    [200, 409],
  );
  assert.equal(
    (await api(`teams/${team.id}/workflow`)).revision,
    beforeRace.revision + 1,
  );
  passed(
    "Simultaneous PostgreSQL workflow saves commit one revision without deadlock or silent overwrite",
  );
  await writeFile(
    join(fixture.directory, "workflow-results.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`Workflow evidence: ${fixture.directory}`);
} catch (error) {
  await page.screenshot({
    path: join(fixture.directory, "workflow-failure.png"),
    fullPage: true,
  });
  console.error(`Workflow evidence: ${fixture.directory}`);
  if (worker) console.error(worker.logs().slice(-3000));
  throw error;
} finally {
  if (worker?.exitCode === null) worker.kill();
  await worker?.finished;
  await temporal?.close();
  await fixture.close();
}
