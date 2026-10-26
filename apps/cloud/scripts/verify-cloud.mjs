import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const checks = [];
const owner = await fixture.ownerContext.newPage();
const memberContext = await fixture.createContext();
const member = await memberContext.newPage();
const api = (path, method, data, key) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data, key);
const dialog = (page) => page.getByRole("dialog");
async function signIn(page, email) {
  await page.goto(`${fixture.origin}/cloud/login`);
  await page.getByLabel("Username or email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  await page.getByRole("heading", { name: "Issues", exact: true }).waitFor();
}
async function saveDialog(page, label) {
  await dialog(page).getByRole("button", { name: label, exact: true }).click();
  await dialog(page).waitFor({ state: "hidden" });
}
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

try {
  await signIn(owner, "owner@example.test");
  await owner.getByRole("link", { name: "Settings", exact: true }).click();
  await owner.getByRole("button", { name: "Edit organization" }).click();
  await dialog(owner)
    .getByLabel("Name", { exact: true })
    .fill("Verification studio");
  await dialog(owner).getByLabel("Accent").selectOption("violet");
  await saveDialog(owner, "Save organization");
  await owner.locator('.cloud-shell[data-cloud-accent="violet"]').waitFor();
  assert.equal(
    (await api("workspace")).organization.name,
    "Verification studio",
  );
  passed("Organization branding persists and updates navigation");

  await owner.getByRole("tab", { name: "Members", exact: true }).click();
  await owner
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await dialog(owner).getByLabel("Email").fill("member@example.test");
  await saveDialog(owner, "Create invitation");
  const invitation = await owner.getByLabel("Invitation link").inputValue();
  await member.goto(invitation);
  await member.getByLabel("Name", { exact: true }).fill("Member");
  await member.getByLabel("Password", { exact: true }).fill(fixture.password);
  await member.getByRole("button", { name: "Join organization" }).click();
  await member.waitForURL("**/cloud/issues");
  assert.equal(
    await member.getByRole("link", { name: "Settings", exact: true }).count(),
    0,
  );
  passed("Invitation acceptance and role-aware navigation");

  await owner.getByRole("link", { name: "Teams", exact: true }).click();
  await owner.getByRole("button", { name: "New team" }).click();
  await dialog(owner).getByLabel("Name", { exact: true }).fill("Engineering");
  await dialog(owner).getByLabel("Issue prefix").fill("ENG");
  await dialog(owner).getByLabel("Visibility").selectOption("private");
  await saveDialog(owner, "Create team");
  await owner.getByRole("button", { name: "Edit team", exact: true }).click();
  await dialog(owner)
    .getByRole("checkbox", { name: "Member", exact: true })
    .check();
  await saveDialog(owner, "Save team");
  await member.reload();
  await member.getByRole("button", { name: "New issue" }).waitFor();
  passed("Private team membership grants access");

  await owner.getByRole("link", { name: "Projects", exact: true }).click();
  await owner.getByRole("button", { name: "New project" }).click();
  await dialog(owner).getByLabel("Name", { exact: true }).fill("Cloud project");
  await dialog(owner).getByLabel("Description").fill("Verification project");
  await saveDialog(owner, "Create project");
  await owner.getByRole("link", { name: "Cycles", exact: true }).click();
  await owner.getByRole("button", { name: "New cycle" }).click();
  await dialog(owner).getByLabel("Name", { exact: true }).fill("Cycle one");
  await dialog(owner).getByLabel("Start date").fill("2026-10-01");
  await dialog(owner)
    .getByLabel("End date (exclusive)", { exact: true })
    .fill("2026-10-15");
  await dialog(owner)
    .getByLabel("Capacity (points)", { exact: true })
    .fill("30");
  await saveDialog(owner, "Create cycle");
  await owner.getByRole("link", { name: "Issues", exact: true }).click();
  await owner.getByRole("button", { name: "New issue" }).click();
  await dialog(owner)
    .getByLabel("Title", { exact: true })
    .fill("Reconnect after interrupted work");
  await saveDialog(owner, "Create issue");
  await owner.waitForURL(/\/cloud\/issues\/[a-f0-9-]+$/);
  const issueUrl = owner.url();
  const issueId = new URL(issueUrl).pathname.split("/").at(-1);
  await owner
    .getByLabel("Project", { exact: true })
    .selectOption({ label: "Cloud project" });
  await owner
    .getByLabel("Cycle", { exact: true })
    .selectOption({ label: "Cycle one" });
  await owner
    .getByLabel("Assignee", { exact: true })
    .selectOption({ label: "Member" });
  await owner
    .getByLabel("Status", { exact: true })
    .selectOption({ label: "Ready" });
  await owner
    .getByLabel("Acceptance criteria")
    .fill("Resuming never duplicates an accepted change.");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await owner.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  passed(
    "Project, cycle and issue creation with assignment and acceptance criteria",
  );

  await member.goto(issueUrl);
  await member.getByLabel("Title", { exact: true }).fill("Stale member draft");
  await owner.getByLabel("Priority", { exact: true }).selectOption("high");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await owner.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  await member.getByRole("button", { name: "Save changes" }).click();
  await member
    .getByRole("alert")
    .filter({ hasText: "This item changed" })
    .waitFor();
  assert.equal(
    await member.getByLabel("Title", { exact: true }).inputValue(),
    "Stale member draft",
  );
  await member.getByRole("button", { name: "Reload issue" }).click();
  await assertEventually(
    async () =>
      (await member.getByLabel("Title", { exact: true }).inputValue()) ===
      "Reconnect after interrupted work",
  );
  passed("Concurrent issue edits retain the draft and reject lost updates");

  await owner.getByRole("tab", { name: "Planning poker", exact: true }).click();
  await member
    .getByRole("tab", { name: "Planning poker", exact: true })
    .click();
  await owner.getByRole("button", { name: "Start poker" }).click();
  await owner.getByRole("button", { name: "Vote 3", exact: true }).click();
  await member.getByRole("button", { name: "Vote 5", exact: true }).click();
  const roundId = (await api(`issues/${issueId}/poker`)).rounds[0].id;
  await assertEventually(
    async () => (await api(`poker/${roundId}`)).votes.length === 2,
  );
  const beforeReveal = await api(`poker/${roundId}`);
  assert.equal(
    beforeReveal.votes.find((vote) => vote.name === "Member").card,
    null,
  );
  await owner.getByRole("button", { name: "Reveal votes" }).click();
  await owner.getByLabel("Agreed estimate").selectOption("5");
  await owner.getByLabel("Rationale").fill("Includes reconnect verification");
  await owner.getByRole("button", { name: "Record estimate" }).click();
  await assertEventually(
    async () => (await api(`issues/${issueId}`)).estimate === "5",
  );
  assert.equal(
    (await api(`poker/${roundId}`)).votes.find((vote) => vote.name === "Member")
      .card,
    "5",
  );
  await owner.getByRole("status").filter({ hasText: "Estimate:" }).waitFor();
  await owner.evaluate(() => scrollTo(0, 0));
  await owner.screenshot({
    path: join(fixture.directory, "issue-poker-desktop.png"),
    fullPage: true,
  });
  passed(
    "Two-user poker hides votes, reveals them and records an agreed estimate",
  );

  await owner.getByRole("link", { name: "Teams", exact: true }).click();
  await owner.getByRole("button", { name: "Estimate scale" }).click();
  await dialog(owner).locator("#card-4").fill("Medium");
  await dialog(owner).locator("#points-4").fill("8");
  await saveDialog(owner, "Save scale");
  assert.equal((await api(`issues/${issueId}`)).estimatePoints, 5);
  await owner.goto(issueUrl);
  await owner.getByLabel("Estimate", { exact: true }).selectOption("Medium");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await owner.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  assert.equal((await api(`issues/${issueId}`)).estimatePoints, 8);
  passed(
    "Custom estimate cards preserve historical points and apply new values",
  );

  await member.reload();
  await member
    .getByRole("tab", { name: "Planning poker", exact: true })
    .click();
  await member.getByRole("button", { name: "Start poker" }).click();
  await member.getByRole("button", { name: "Vote 3", exact: true }).waitFor();
  await owner.getByRole("link", { name: "Settings", exact: true }).click();
  await owner.getByRole("tab", { name: "Members", exact: true }).click();
  await owner.getByRole("button", { name: "Edit access for Member" }).click();
  await dialog(owner)
    .getByLabel("Access", { exact: true })
    .selectOption("suspended");
  await saveDialog(owner, "Save access");
  assert.equal(
    (
      await memberContext.request.get(`${fixture.origin}/api/v1/workspace`)
    ).status(),
    401,
  );
  await owner.goto(issueUrl);
  await owner.getByRole("tab", { name: "Planning poker", exact: true }).click();
  await owner
    .getByRole("button", { name: "Take over round", exact: true })
    .click();
  await saveDialog(owner, "Take over round");
  await owner.getByRole("button", { name: "Close round", exact: true }).click();
  await owner.getByText("Round closed", { exact: true }).waitFor();
  passed(
    "Suspension invalidates sessions and administrators recover abandoned poker",
  );

  const teamId = (await api("workspace")).teams[0].id;
  const key = randomUUID();
  const retried = await Promise.all(
    Array.from({ length: 6 }, () =>
      api("issues", "POST", { teamId, title: "Concurrent receipt" }, key),
    ),
  );
  assert.equal(new Set(retried.map((item) => item.id)).size, 1);
  assert.equal(
    (await api("issues?query=Concurrent%20receipt")).issues.length,
    1,
  );
  await fixture.restart();
  await owner.reload();
  assert.equal((await api(`issues/${issueId}`)).estimatePoints, 8);
  assert.equal(
    (await api("issues", "POST", { teamId, title: "Concurrent receipt" }, key))
      .id,
    retried[0].id,
  );
  passed(
    "PostgreSQL concurrent retries and process restart retain one accepted command",
  );

  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.getByRole("button", { name: "Open navigation" }).click();
  await owner.getByRole("link", { name: "Settings", exact: true }).click();
  await owner.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert.ok(
    await owner.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await owner.screenshot({
    path: join(fixture.directory, "settings-mobile.png"),
    fullPage: true,
  });
  await owner.getByRole("button", { name: "Edit organization" }).click();
  await owner.keyboard.press("Escape");
  await dialog(owner).waitFor({ state: "hidden" });
  assert.equal(
    await owner
      .getByRole("button", { name: "Edit organization" })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  passed("Mobile layout and dialog keyboard focus");
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await owner
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
