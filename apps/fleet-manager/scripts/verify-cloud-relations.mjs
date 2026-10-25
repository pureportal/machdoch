import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudApi,
  statusReference,
  cloudBrowserFixture,
  createPasswordInvitation,
  acceptPasswordInvitation,
  executionProviderFixture,
  assertEventually,
} from "./cloud-browser-fixture.mjs";

let droppedPath = "";
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) => {
    if (path === droppedPath && status === 201) return true;
    return false;
  },
});
const page = await fixture.ownerContext.newPage();
const memberContext = await fixture.createContext(),
  viewerContext = await fixture.createContext();
const member = await memberContext.newPage(),
  viewer = await viewerContext.newPage();
const checks = [];
const api = (path, method, body, key) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body, key);
const passed = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
async function raw(context, path, data, key = randomUUID()) {
  const csrf = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  return context.request.post(`${fixture.origin}/api/v1/${path}`, {
    headers: {
      Origin: fixture.origin,
      "x-machdoch-cloud-csrf": csrf,
      "Idempotency-Key": key,
    },
    data,
  });
}
async function changeIssue(id, patch) {
  const current = await api(`issues/${id}`);
  const {
    teamId: _team,
    id: _,
    identifier: _key,
    updatedAt: _time,
    estimatePoints: _estimate,
    state: _category,
    statusName: _statusName,
    ...input
  } = current;
  return api(`issues/${id}`, "PATCH", { ...input, ...patch });
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  for (const [role, context] of [
    ["member", memberContext],
    ["viewer", viewerContext],
  ]) {
    const invitation = await createPasswordInvitation(
      fixture,
      fixture.ownerContext,
      { email: `${role}@example.test`, role },
    );
    await acceptPasswordInvitation(fixture, context, invitation.url, {
      name: role,
      password: fixture.password,
    });
    await cloudApi(fixture, context, "auth/login", "POST", {
      email: `${role}@example.test`,
      password: fixture.password,
    });
  }
  const team = await api("teams", "POST", {
    name: "Delivery",
    key: "DL",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Workspace",
    description: "",
  });
  const main = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Ship workspace navigation",
    acceptanceCriteria: "Keyboard navigation passes",
    estimate: "3",
  });
  const blocker = await api("issues", "POST", {
    teamId: team.id,
    title: "Complete navigation contract",
  });
  const url = `${fixture.origin}/cloud/issues/${main.id}`;
  await page.goto(url);
  const relationships = page.getByRole("region", {
    name: "Issue relationships",
    exact: true,
  });
  await page
    .getByLabel("Description", { exact: true })
    .fill("Unsaved parent draft");
  await relationships
    .getByRole("button", { name: "New sub-issue", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "New sub-issue", exact: true });
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Add keyboard shortcuts");
  droppedPath = `/api/v1/issues/${main.id}/children`;
  await dialog
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  droppedPath = "";
  await dialog
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await relationships
    .getByRole("link", { name: /Add keyboard shortcuts/ })
    .waitFor();
  assert.equal(page.url(), url);
  assert.equal(
    await page.getByLabel("Description", { exact: true }).inputValue(),
    "Unsaved parent draft",
  );
  const childLinks = (await api(`issues/${main.id}/relations`)).relations;
  assert.equal(childLinks.length, 1);
  const child = childLinks[0].issue;
  assert.equal((await api(`issues/${child.id}`)).projectId, project.id);
  passed(
    "Sub-issue creation survives a lost response without duplicates or losing the parent's draft",
  );

  await relationships
    .getByRole("button", { name: "Link issue", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Link issue", exact: true });
  await dialog
    .getByLabel("Relationship", { exact: true })
    .selectOption("blocked_by");
  await dialog.getByLabel("Find issues").fill("navigation contract");
  await dialog
    .getByRole("radio", { name: /Complete navigation contract/ })
    .check();
  await changeIssue(blocker.id, { title: "Review navigation contract" });
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "An issue changed" })
    .waitFor();
  assert.equal((await api(`issues/${main.id}/relations`)).relations.length, 1);
  await dialog
    .getByRole("region", { name: "Latest issue versions" })
    .getByText(/Review navigation contract/)
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Add link", exact: true })
      .isDisabled(),
    true,
  );
  await dialog.getByLabel("Use these versions", { exact: true }).check();
  droppedPath = `/api/v1/issues/${main.id}/relations`;
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  droppedPath = "";
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await relationships
    .getByRole("group", { name: "Blocked by", exact: true })
    .getByRole("link", { name: /Review navigation contract/ })
    .waitFor();
  assert.equal((await api(`issues/${main.id}/relations`)).relations.length, 2);
  passed(
    "Search selects an issue, rejects a stale target, and retries a lost dependency response exactly once",
  );

  const privateTeam = await api("teams", "POST", {
    name: "Private",
    key: "PV",
    visibility: "private",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const secret = await api("issues", "POST", {
    teamId: privateTeam.id,
    title: "Confidential review",
  });
  const privateLink = await api(`issues/${main.id}/relations`, "POST", {
    kind: "blocked_by",
    targetId: secret.id,
    sourceRevision: 1,
    targetRevision: 1,
  });
  await Promise.all([member.goto(url), viewer.goto(url)]);
  const memberRelations = member.getByRole("region", {
    name: "Issue relationships",
    exact: true,
  });
  await memberRelations
    .getByRole("link", { name: /Review navigation contract/ })
    .waitFor();
  assert.equal(await memberRelations.getByText(/Confidential/).count(), 0);
  const scoped = await cloudApi(
    fixture,
    memberContext,
    `issues/${main.id}/relations`,
  );
  assert.equal(scoped.relations.length, 2);
  assert.ok(!JSON.stringify(scoped).includes(secret.id));
  assert.ok(!JSON.stringify(scoped).includes(privateLink.id));
  await viewer
    .getByRole("region", { name: "Issue relationships" })
    .getByRole("link", { name: /Add keyboard shortcuts/ })
    .waitFor();
  assert.equal(
    await viewer
      .getByRole("button", { name: "Link issue", exact: true })
      .count(),
    0,
  );
  assert.equal(
    (
      await raw(viewerContext, `issues/${main.id}/relations`, {
        kind: "related",
        targetId: child.id,
        sourceRevision: 1,
        targetRevision: 1,
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await raw(
        memberContext,
        `issues/${main.id}/relations/${privateLink.id}/remove`,
        {},
      )
    ).status(),
    404,
  );
  passed(
    "Private relationships expose no identifiers or counts; viewers and inaccessible endpoints cannot mutate links",
  );

  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Navigation checks",
    target: "cloud",
    repository: "https://github.com/example/project",
    baseCommit: "a".repeat(40),
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 300,
    maxTokens: 10000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  await changeIssue(blocker.id, {
    status: await statusReference(
      fixture,
      fixture.ownerContext,
      team.id,
      "complete",
    ),
  });
  await member.getByRole("button", { name: "New task", exact: true }).click();
  const taskDialog = member.getByRole("dialog", {
    name: "New AI task",
    exact: true,
  });
  await taskDialog
    .getByLabel("Execution profile", { exact: true })
    .selectOption(profile.id);
  await taskDialog
    .getByRole("button", { name: "Queue task", exact: true })
    .click();
  await taskDialog
    .getByRole("alert")
    .filter({ hasText: "prerequisites" })
    .waitFor();
  assert.ok(!(await taskDialog.innerText()).includes("Confidential"));
  await changeIssue(secret.id, {
    status: await statusReference(
      fixture,
      fixture.ownerContext,
      privateTeam.id,
      "complete",
    ),
  });
  await taskDialog
    .getByRole("button", { name: "Queue task", exact: true })
    .click();
  await taskDialog.waitFor({ state: "hidden" });
  const run = (await api(`runs?issueId=${main.id}`)).runs[0];
  assert.equal((await api(`runs/${run.id}`)).contextChanged, false);
  await member.goto(`${fixture.origin}/cloud/tasks/${run.id}`);
  await changeIssue(secret.id, {
    status: await statusReference(
      fixture,
      fixture.ownerContext,
      privateTeam.id,
      "active",
    ),
  });
  await member
    .getByRole("status")
    .filter({ hasText: "Planning has changed" })
    .waitFor();
  const changed = await api(`runs/${run.id}`);
  assert.equal(changed.contextChanged, true);
  assert.equal(changed.state, "queued");
  assert.ok(!JSON.stringify(changed).includes(secret.id));
  assert.ok(!("planningDigest" in changed));
  passed(
    "Task admission checks private prerequisites without disclosure, and existing tasks report changed context",
  );

  const left = await api("issues", "POST", {
    teamId: team.id,
    title: "Concurrent left",
  });
  const right = await api("issues", "POST", {
    teamId: team.id,
    title: "Concurrent right",
  });
  const attempts = await Promise.all(
    [
      [left, right],
      [right, left],
    ].map(([a, b]) =>
      raw(fixture.ownerContext, `issues/${a.id}/relations`, {
        kind: "blocks",
        targetId: b.id,
        sourceRevision: 1,
        targetRevision: 1,
      }),
    ),
  );
  assert.deepEqual(
    attempts.map((response) => response.status()).sort((a, b) => a - b),
    [201, 409],
  );
  assert.equal((await api(`issues/${left.id}/relations`)).relations.length, 1);
  const parentAttempts = await Promise.all(
    [left, right].map((parent) =>
      raw(fixture.ownerContext, `issues/${parent.id}/relations`, {
        kind: "child",
        targetId: main.id,
        sourceRevision: 1,
        targetRevision: 1,
      }),
    ),
  );
  assert.deepEqual(
    parentAttempts.map((response) => response.status()).sort((a, b) => a - b),
    [201, 409],
  );
  passed(
    "Simultaneous PostgreSQL edits reject reciprocal cycles and competing parents without deadlock",
  );

  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  const childRow = relationships
    .getByRole("listitem")
    .filter({ hasText: "Add keyboard shortcuts" });
  await childRow
    .getByRole("button", {
      name: `Remove link to ${child.identifier}`,
      exact: true,
    })
    .click();
  const remove = page.getByRole("dialog", { name: "Remove link", exact: true });
  await remove
    .getByRole("button", { name: "Remove link", exact: true })
    .click();
  await remove.waitFor({ state: "hidden" });
  await childRow.waitFor({ state: "hidden" });
  assert.equal(
    await relationships
      .getByRole("heading", { name: "Relationships", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "relationships-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await fixture.restart();
  await page.reload();
  await relationships
    .getByRole("link", { name: /Review navigation contract/ })
    .waitFor();
  assert.equal(
    await relationships
      .getByRole("link", { name: /Add keyboard shortcuts/ })
      .count(),
    0,
  );
  assert.equal((await api(`issues/${main.id}`)).estimate, "3");
  assert.equal((await api(`issues/${main.id}`)).revision, 1);
  await assertEventually(
    async () => (await api(`runs/${run.id}`)).contextChanged,
    "Planning context did not persist",
  );
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "Removal returns keyboard focus, fits mobile, and persists across restart without changing issue estimates or narrative revisions",
  );
  const workspace = await api("workspace");
  const batch = (
    await fixture.database.query(
      `INSERT INTO cloud_issues(organization_id,id,team_id,identifier,title,description,acceptance_criteria,state,priority,status_id)
     SELECT $1,gen_random_uuid(),$2,'PG-'||n,'Search batch '||lpad(n::text,3,'0'),'','','backlog','none',(SELECT default_status_id FROM cloud_team_workflows WHERE organization_id=$1 AND team_id=$2) FROM generate_series(1,110) n RETURNING id`,
      [workspace.organization.id, team.id],
    )
  ).rows;
  await relationships
    .getByRole("button", { name: "Link issue", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Link issue", exact: true });
  await dialog.getByLabel("Find issues").fill("Search batch");
  await dialog
    .getByRole("button", { name: "More issues", exact: true })
    .waitFor();
  assert.equal(await dialog.getByRole("radio").count(), 100);
  await dialog
    .getByRole("button", { name: "More issues", exact: true })
    .click();
  await assertEventually(
    async () => (await dialog.getByRole("radio").count()) === 110,
    "Issue search did not load the next page",
  );
  await dialog.getByRole("radio").last().check();
  await dialog.getByRole("button", { name: "Add link", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  for (const item of batch.slice(0, 11))
    await api(`issues/${main.id}/relations`, "POST", {
      kind: "child",
      targetId: item.id,
      sourceRevision: 1,
      targetRevision: 1,
    });
  const subIssues = relationships.getByRole("group", {
    name: "Sub-issues",
    exact: true,
  });
  await subIssues
    .getByRole("button", { name: "Show all 11", exact: true })
    .waitFor();
  assert.equal(await subIssues.getByRole("link").count(), 10);
  await subIssues
    .getByRole("button", { name: "Show all 11", exact: true })
    .click();
  assert.equal(await subIssues.getByRole("link").count(), 11);
  await subIssues
    .getByRole("button", { name: "Show fewer", exact: true })
    .click();
  assert.equal(await subIssues.getByRole("link").count(), 10);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: join(fixture.directory, "relationships-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "Issue search pages beyond 100 results and long relationship groups expand without truncation or mobile overflow",
  );
  await writeFile(
    join(fixture.directory, "relation-results.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`Relationship evidence: ${fixture.directory}`);
} catch (error) {
  await page.screenshot({
    path: join(fixture.directory, "relationships-failure.png"),
    fullPage: true,
  });
  console.error(`Relationship evidence: ${fixture.directory}`);
  throw error;
} finally {
  await fixture.close();
}
