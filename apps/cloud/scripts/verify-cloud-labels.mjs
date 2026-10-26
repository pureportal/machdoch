import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPasswordInvitation,
  acceptPasswordInvitation,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const memberContext = await fixture.createContext();
const member = await memberContext.newPage();
const viewerContext = await fixture.createContext();
const viewer = await viewerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
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
    const invite = await createPasswordInvitation(
      fixture,
      fixture.ownerContext,
      {
        email: `${role}@example.test`,
        role,
      },
    );
    await acceptPasswordInvitation(fixture, context, invite.url, {
      name: role,
      password: fixture.password,
    });
    await cloudApi(fixture, context, "auth/login", "POST", {
      email: `${role}@example.test`,
      password: fixture.password,
    });
  }
  const team = await api("teams", "POST", {
    name: "Labels team",
    key: "LB",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  const first = await api("issues", "POST", {
    teamId: team.id,
    title: "Labeled issue",
    estimate: "3",
  });
  const second = await api("issues", "POST", {
    teamId: team.id,
    title: "Another issue",
  });
  const poker = await api("poker", "POST", {
    issueId: first.id,
    issueRevision: 1,
  });
  await page.goto(`${fixture.origin}/cloud/teams`);
  await page
    .locator("summary")
    .filter({ hasText: /^Labels$/ })
    .click();
  await page.getByRole("button", { name: "New label", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Bug");
  await dialog.getByLabel("Color", { exact: true }).selectOption("red");
  await dialog
    .getByRole("button", { name: "Create label", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Edit label Bug", exact: true })
    .waitFor();
  const bug = (await api(`teams/${team.id}/labels`)).labels[0];
  const feature = await api(`teams/${team.id}/labels`, "POST", {
    name: "Feature",
    color: "blue",
  });
  const ux = await api(`teams/${team.id}/labels`, "POST", {
    name: "UX",
    color: "purple",
  });
  await page.getByRole("button", { name: "New label", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("bug");
  await dialog
    .getByRole("button", { name: "Create label", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "A label with this name exists" })
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await api(`teams/${team.id}/labels`)).labels.length, 3);
  passed(
    "Team labels can be created through the UI and duplicate names are rejected",
  );

  const issueUrl = `${fixture.origin}/cloud/issues/${first.id}`;
  await Promise.all([page.goto(issueUrl), member.goto(issueUrl)]);
  await page.getByRole("button", { name: "Labels", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Labels", exact: true });
  await dialog.getByRole("checkbox", { name: "Bug", exact: true }).check();
  await dialog
    .getByRole("button", { name: "Save labels", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await member
    .getByRole("region", { name: "Issue labels", exact: true })
    .getByRole("link", { name: "Bug", exact: true })
    .waitFor();
  assert.equal((await api(`issues/${first.id}`)).revision, 1);
  assert.equal((await api(`poker/${poker.id}`)).stale, false);
  passed(
    "Assignments synchronize across users without changing issue or poker revisions",
  );

  await Promise.all([
    page.getByRole("button", { name: "Labels", exact: true }).click(),
    member.getByRole("button", { name: "Labels", exact: true }).click(),
  ]);
  const memberDialog = member.getByRole("dialog", {
    name: "Labels",
    exact: true,
  });
  await dialog.getByRole("checkbox", { name: "Bug", exact: true }).uncheck();
  await dialog.getByRole("checkbox", { name: "Feature", exact: true }).check();
  await memberDialog.getByRole("checkbox", { name: "UX", exact: true }).check();
  await memberDialog
    .getByRole("button", { name: "Save labels", exact: true })
    .click();
  await memberDialog.waitFor({ state: "hidden" });
  await dialog
    .getByRole("button", { name: "Save labels", exact: true })
    .click();
  await dialog
    .getByRole("region", { name: "Latest labels", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "Feature", exact: true })
      .isChecked(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(fixture.directory, "labels-conflict-mobile.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Keep my changes", exact: true })
    .click();
  assert.equal(
    await dialog.getByRole("checkbox", { name: "UX", exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "Bug", exact: true })
      .isChecked(),
    false,
  );
  await dialog
    .getByRole("button", { name: "Save labels", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    (await api(`issues/${first.id}/labels`)).labels
      .map((label) => label.id)
      .sort((a, b) => a.localeCompare(b)),
    [feature.id, ux.id].sort((a, b) => a.localeCompare(b)),
  );
  passed(
    "Stale selections retain draft additions and removals and reconcile concurrent labels",
  );

  await page
    .getByRole("region", { name: "Issue labels", exact: true })
    .getByRole("link", { name: "Feature", exact: true })
    .click();
  await page.getByRole("link", { name: /Labeled issue/ }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: /Another issue/ }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Filter by label").inputValue(),
    feature.id,
  );
  await page.getByLabel("Search issues").fill("Labeled");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/query=Labeled/);
  await page.screenshot({
    path: join(fixture.directory, "labels-filter-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByRole("link", { name: /Another issue/ }).waitFor();
  assert.equal(await page.getByLabel("Search issues").inputValue(), "");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  passed(
    "Label links filter issues and clearing filters resets the search field on mobile",
  );

  await page.goto(`${fixture.origin}/cloud/teams`);
  await page
    .locator("summary")
    .filter({ hasText: /^Labels$/ })
    .click();
  await page
    .getByRole("button", { name: "Edit label Feature", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Archived", exact: true }).check();
  await dialog.getByRole("button", { name: "Save label", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await member
    .getByRole("region", { name: "Issue labels", exact: true })
    .getByRole("link", { name: "Feature Archived", exact: true })
    .waitFor();
  await page.goto(`${fixture.origin}/cloud/issues/${second.id}`);
  await page.getByRole("button", { name: "Labels", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("checkbox", { name: /Feature/ })
      .count(),
    0,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await viewer.goto(issueUrl);
  await viewer
    .getByRole("region", { name: "Issue labels", exact: true })
    .getByRole("link", { name: "UX", exact: true })
    .waitFor();
  assert.equal(
    await viewer.getByRole("button", { name: "Labels", exact: true }).count(),
    0,
  );
  passed(
    "Archived labels remain visible on existing issues, disappear from new choices, and viewers cannot edit assignments",
  );

  const csrf = (await fixture.ownerContext.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  const updates = await Promise.all(
    [bug.id, ux.id].map((labelId) =>
      fixture.ownerContext.request.patch(
        `${fixture.origin}/api/v1/issues/${second.id}/labels`,
        {
          headers: {
            Origin: fixture.origin,
            "x-machdoch-cloud-csrf": csrf,
            "Idempotency-Key": randomUUID(),
          },
          data: { revision: 1, labelIds: [labelId] },
        },
      ),
    ),
  );
  assert.deepEqual(
    updates.map((response) => response.status()).sort((a, b) => a - b),
    [200, 409],
  );
  assert.equal((await api(`issues/${second.id}/labels`)).revision, 2);
  await fixture.restart();
  await member.reload();
  await member
    .getByRole("region", { name: "Issue labels", exact: true })
    .getByRole("link", { name: "UX", exact: true })
    .waitFor();
  assert.equal((await api(`issues/${first.id}`)).estimate, "3");
  assert.equal((await api(`poker/${poker.id}`)).stale, false);
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "Simultaneous PostgreSQL updates accept one revision and labels survive a server restart",
  );
  await writeFile(
    join(fixture.directory, "label-results.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`Label evidence: ${fixture.directory}`);
} catch (error) {
  await page.screenshot({
    path: join(fixture.directory, "labels-failure.png"),
    fullPage: true,
  });
  console.error(`Label evidence: ${fixture.directory}`);
  throw error;
} finally {
  await fixture.close();
}
