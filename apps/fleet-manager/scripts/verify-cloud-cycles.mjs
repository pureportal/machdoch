import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertEventually,
  cloudApi,
  statusReference,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
try {
  await page.goto(`${fixture.origin}/cloud/login`);
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  const team = await api("teams", "POST", {
    name: "Cycle team",
    key: "CY",
    visibility: "organization",
    estimateScale: [
      { label: "Small", points: 3 },
      { label: "Large", points: 8 },
    ],
  });
  const current = await api("cycles", "POST", {
    teamId: team.id,
    name: "Current cycle",
    startsOn: "2026-10-18",
    endsOn: "2026-11-01",
    timezone: "Europe/Berlin",
    capacity: 20,
  });
  const future = await api("cycles", "POST", {
    teamId: team.id,
    name: "Future cycle",
    startsOn: "2026-11-01",
    endsOn: "2026-11-15",
    timezone: "Europe/Berlin",
    capacity: 30,
  });
  const unfinished = await api("issues", "POST", {
    teamId: team.id,
    cycleId: current.id,
    title: "Carry unfinished work",
    estimate: "Small",
  });
  await api("issues", "POST", {
    teamId: team.id,
    cycleId: current.id,
    title: "Completed work",
    status: await statusReference(
      fixture,
      fixture.ownerContext,
      team.id,
      "complete",
    ),
    estimate: "Large",
  });
  await page.goto(`${fixture.origin}/cloud/cycles/${current.id}`);
  await page.getByRole("button", { name: "Start cycle", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start cycle", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Complete cycle", exact: true })
    .waitFor();
  assert.equal((await api(`cycles/${current.id}`)).committedTotals.points, 11);
  await page.getByRole("link", { name: "Plan issues", exact: true }).click();
  await page.getByRole("button", { name: "New issue", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Title", { exact: true })
    .fill("Added during cycle");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await page.waitForURL(/\/cloud\/issues\/[a-f0-9-]+$/);
  assert.equal(
    await page.getByLabel("Cycle", { exact: true }).inputValue(),
    current.id,
  );
  const lateId = new URL(page.url()).pathname.split("/").at(-1);
  passed(
    "Cycle start freezes commitment and Plan issues assigns new work to the cycle",
  );

  await page
    .getByLabel("Description", { exact: true })
    .fill("Keep this draft after failed refresh");
  const issueRead = `**/api/v1/issues/${lateId}`;
  await page.route(issueRead, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Refresh unavailable. Try again.",
            code: "unavailable",
          }),
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Refresh unavailable" })
    .waitFor();
  assert.equal(
    await page.getByRole("status").filter({ hasText: "Saved" }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Description", { exact: true }).inputValue(),
    "Keep this draft after failed refresh",
  );
  await page.unroute(issueRead);
  await page.getByRole("button", { name: "Reload issue", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Refresh unavailable" })
    .waitFor({ state: "hidden" });
  passed(
    "A failed post-save refresh keeps the draft and does not report success",
  );

  await page.goto(`${fixture.origin}/cloud/cycles/${current.id}`);
  await page
    .getByRole("button", { name: "Complete cycle", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Move unfinished issues to")
    .selectOption(future.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Complete cycle", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await assertEventually(
    async () => (await api(`cycles/${current.id}`)).cycle.status === "closed",
  );
  await page.getByText("closed", { exact: true }).waitFor();
  assert.equal((await api(`issues/${unfinished.id}`)).cycleId, future.id);
  const closed = await api(`cycles/${current.id}`);
  assert.equal(closed.issues.length, 3);
  assert.equal(closed.commitment.length, 2);
  assert.equal(closed.carriedIssueIds.length, 2);
  await page
    .getByText("Original commitment · 2 issues", { exact: true })
    .click();
  await page.screenshot({
    path: join(fixture.directory, "cycle-completed.png"),
    fullPage: true,
  });
  passed(
    "Cycle completion carries unfinished issues and keeps the original and final scope",
  );

  await page.goto(`${fixture.origin}/cloud/issues/${unfinished.id}`);
  await page.getByLabel("Estimate", { exact: true }).selectOption("Large");
  await page
    .getByLabel("Status", { exact: true })
    .selectOption({ label: "Done" });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  assert.deepEqual(await api(`cycles/${current.id}`), closed);
  await fixture.restart();
  assert.deepEqual(await api(`cycles/${current.id}`), closed);
  passed("Later work and process restarts cannot change closed-cycle evidence");
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(`${fixture.logs()}\nEvidence: ${fixture.directory}\n`);
  throw error;
} finally {
  await fixture.close();
}
