import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
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
  const team = await api("teams", "POST", {
    name: "Projects",
    key: "PR",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Original project",
    description: "Original description",
  });
  await page.goto(`${fixture.origin}/cloud/projects`);
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Edit project",
    exact: true,
  });
  await dialog.getByLabel("Name", { exact: true }).fill("Updated project");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Updated description");
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("link", { name: "Updated project", exact: true })
    .waitFor();
  assert.equal((await api(`projects/${project.id}`)).revision, 2);
  passed("Project edits persist and refresh the catalog");

  const second = await fixture.ownerContext.newPage();
  await second.goto(`${fixture.origin}/cloud/projects`);
  await Promise.all([
    page.getByRole("button", { name: "Edit project", exact: true }).click(),
    second.getByRole("button", { name: "Edit project", exact: true }).click(),
  ]);
  const newer = second.getByRole("dialog");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("My unsaved description");
  await newer.getByLabel("Name", { exact: true }).fill("Concurrent name");
  await newer
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await newer.waitFor({ state: "hidden" });
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await dialog.getByRole("region", { name: "Latest saved version" }).waitFor();
  assert.equal(
    await dialog.getByLabel("Description", { exact: true }).inputValue(),
    "My unsaved description",
  );
  assert.equal((await api(`projects/${project.id}`)).name, "Concurrent name");
  await dialog
    .getByRole("button", { name: "Keep my changes", exact: true })
    .click();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Concurrent name",
  );
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await api(`projects/${project.id}`), {
    id: project.id,
    teamId: team.id,
    name: "Concurrent name",
    description: "My unsaved description",
    revision: 4,
  });
  passed(
    "Concurrent edits retain the draft and merge unchanged fields from the latest revision",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Discard this edit");
  await api(`projects/${project.id}`, "PATCH", {
    revision: 4,
    name: "Latest project",
    description: "Latest description",
  });
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Use latest", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(fixture.directory, "project-conflict-mobile.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Use latest", exact: true }).click();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Latest project",
  );
  assert.equal(
    await dialog.getByLabel("Description", { exact: true }).inputValue(),
    "Latest description",
  );
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await assertEventually(() =>
    page
      .getByRole("button", { name: "Edit project", exact: true })
      .evaluate((element) => element === document.activeElement),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  passed(
    "Mobile conflict recovery can adopt the saved version and returns keyboard focus",
  );
  await page.getByRole("link", { name: "Latest project", exact: true }).waitFor();
  await fixture.restart();
  await page.reload();
  await page
    .getByRole("link", { name: "Latest project", exact: true })
    .waitFor();
  assert.equal(
    (await api(`projects/${project.id}`)).description,
    "Latest description",
  );
  assert.deepEqual(fixture.pageErrors, []);
  passed("Project changes survive a server restart");
  await writeFile(
    join(fixture.directory, "project-results.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`Project evidence: ${fixture.directory}`);
} finally {
  await fixture.close();
}
