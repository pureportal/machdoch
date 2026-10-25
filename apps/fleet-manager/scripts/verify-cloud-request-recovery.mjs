import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudApi, cloudBrowserFixture } from "./cloud-browser-fixture.mjs";

let droppedPath = null;
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) => {
    if (path !== droppedPath || status !== 200) return false;
    return true;
  },
});
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
    name: "Recovery",
    key: "RC",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Original",
    description: "",
  });
  await page.goto(`${fixture.origin}/cloud/projects`);
  await page.clock.install();
  const endpoint = `${fixture.origin}/api/v1/projects/${project.id}`;
  const keys = [];
  page.on("request", (request) => {
    if (request.url() === endpoint && request.method() === "PATCH")
      keys.push(request.headers()["idempotency-key"]);
  });
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Edit project",
    exact: true,
  });
  await dialog.getByLabel("Name", { exact: true }).fill("Recovered project");
  let captured;
  const intercepted = new Promise((resolve) => {
    captured = resolve;
  });
  await page.route(endpoint, async (route) => {
    if (route.request().method() === "PATCH") captured(route);
    else await route.continue();
  });
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  const stalled = await intercepted;
  await page.clock.fastForward(30001);
  await dialog
    .getByRole("alert")
    .filter({ hasText: "The request timed out" })
    .waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Recovered project",
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Save project", exact: true })
      .isEnabled(),
    true,
  );
  await stalled.abort();
  await page.unroute(endpoint);
  assert.equal((await api(`projects/${project.id}`)).revision, 1);
  passed(
    "A stalled browser request times out, preserves its draft and unlocks the form",
  );

  droppedPath = `/api/v1/projects/${project.id}`;
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "Cloud did not confirm the request" })
    .waitFor();
  droppedPath = null;
  assert.equal((await api(`projects/${project.id}`)).revision, 2);
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("link", { name: "Recovered project", exact: true })
    .waitFor();
  assert.ok(keys.length >= 3);
  assert.equal(new Set(keys).size, 1);
  assert.ok(keys[0]);
  assert.equal((await api(`projects/${project.id}`)).revision, 2);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_outbox WHERE kind='project.changed' AND subject_id=$1",
        [project.id],
      )
    ).rows[0].count,
    1,
  );
  passed(
    "Retrying after a committed response is lost uses the same command and emits one change event",
  );

  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<html>Private proxy detail</html>",
    }),
  );
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Cloud returned an invalid response" })
    .waitFor();
  assert.equal(
    await page.getByText("Private proxy detail", { exact: false }).count(),
    0,
  );
  await page.unroute(endpoint);
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Recovered project",
  );
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "Malformed proxy responses show a recovery message and a subsequent request succeeds",
  );
  await writeFile(
    join(fixture.directory, "request-recovery-results.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`Request recovery evidence: ${fixture.directory}`);
} catch (error) {
  await writeFile(
    join(fixture.directory, "request-recovery-failure.json"),
    JSON.stringify(
      {
        checks,
        error: error.message,
        visible: await page.locator("body").innerText(),
        pageErrors: fixture.pageErrors,
      },
      null,
      2,
    ),
  );
  console.error(`Request recovery evidence: ${fixture.directory}`);
  throw error;
} finally {
  await fixture.close();
}
