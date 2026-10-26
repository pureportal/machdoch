import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import axe from "axe-core";
import {
  acceptPasswordInvitation,
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
  createPasswordInvitation,
} from "./cloud-browser-fixture.mjs";
import { seedCloudDesign } from "./cloud-design-fixture.mjs";

const fixture = await cloudBrowserFixture();
const output = resolve(
  process.env.CLOUD_DESIGN_OUTPUT ?? "../../.tmp/cloud-planning-design",
);
const page = await fixture.ownerContext.newPage();
const api = (path, method, data) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data);
const captures = [];
const checks = [];
const accessibility = [];
page.setDefaultTimeout(15000);
await mkdir(output, { recursive: true });

async function capture(name, locator = page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    `${name}: page overflow`,
  );
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    })),
  );
  if (violations.length) accessibility.push({ name, violations });
  await locator.screenshot({
    path: join(output, `${name}.png`),
    ...(locator === page ? { fullPage: true } : {}),
  });
  captures.push(name);
  process.stdout.write(`CAPTURE ${name}\n`);
}

function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function appearance(mode) {
  await page.goto(`${fixture.origin}/cloud/account`);
  await page
    .getByRole("button", {
      name: mode.includes("light") ? "Light" : "Dark",
      exact: true,
    })
    .click();
  await page
    .locator(`html[data-theme="${mode.includes("light") ? "light" : "dark"}"]`)
    .waitFor();
  await page.setViewportSize(
    mode.startsWith("mobile")
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  );
}

async function saveDialog(name) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

async function openPoker(issueId) {
  await page.goto(`${fixture.origin}/cloud/issues/${issueId}`);
  await page.getByRole("tab", { name: "Planning poker", exact: true }).click();
  await page
    .getByText("Loading poker…", { exact: true })
    .waitFor({ state: "hidden" });
  await page.locator(".cloud-poker-heading").scrollIntoViewIfNeeded();
}

try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const data = await seedCloudDesign(fixture);
  const modes = ["dark", "light", "mobile-dark", "mobile-light"];
  for (const mode of modes) {
    await appearance(mode);
    for (const [name, path] of [
      ["projects", "projects"],
      ["teams", "teams"],
      ["cycles", "cycles"],
      ["cycle-detail", `cycles/${data.cycle.id}`],
    ]) {
      await page.goto(`${fixture.origin}/cloud/${path}`);
      await page.locator("main h1").waitFor();
      await capture(`${name}-${mode}`);
    }
  }
  await page
    .getByRole("progressbar", { name: "Completed issues", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("progressbar", { name: "Completed issues", exact: true })
      .getAttribute("aria-valuenow"),
    "3",
  );
  await page.getByText("24 points over capacity", { exact: true }).waitFor();
  await page.getByLabel("Search cycle issues").fill("ENG-9");
  await assertEventually(
    async () =>
      (await page.locator(".cloud-cycle-issue-list li").count()) === 1,
  );
  await page.getByLabel("Filter issue status").selectOption("Done");
  await page.getByText("No matching issues.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  assert.equal(await page.locator(".cloud-cycle-issue-list li").count(), 12);
  for (const row of await page.locator(".cloud-cycle-issue-list li").all()) {
    for (const element of await row.locator(":scope > *").all()) {
      const box = await element.boundingBox();
      assert.ok(
        box && box.x >= 0 && box.x + box.width <= 391,
        "Cycle issue metadata is outside the mobile viewport",
      );
    }
  }
  passed(
    "Cycle progress, over-capacity state, mobile metadata and combined issue filters",
  );

  await page.goto(`${fixture.origin}/cloud/projects`);
  await page.getByLabel("Search projects").fill("remote development");
  await assertEventually(
    async () =>
      (await page.locator(".cloud-project-directory > li").count()) === 1,
  );
  await page
    .getByLabel("Filter by team")
    .selectOption({ label: "Product & Design" });
  await page.getByText("No matching projects.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  assert.equal(await page.locator(".cloud-project-directory > li").count(), 3);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Interface review");
  await page
    .getByRole("dialog")
    .getByLabel("Description")
    .fill("Review planning interfaces across desktop and mobile.");
  await capture("project-dialog-mobile-light");
  await saveDialog("Create project");
  const created = (await api("workspace")).projects.find(
    (project) => project.name === "Interface review",
  );
  assert.ok(created);
  await page
    .locator(`#planning-${created.id}`)
    .getByRole("button", { name: "Edit project" })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Planning interface review");
  await saveDialog("Save project");
  await page.reload();
  const projectLink = page.getByRole("link", {
    name: "Planning interface review",
    exact: true,
  });
  await projectLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/cloud/issues?projectId=${created.id}`);
  passed(
    "Project search, team filtering, mobile creation, persisted editing and keyboard navigation",
  );

  await page.goto(`${fixture.origin}/cloud/teams`);
  await page.getByLabel("Search teams").fill("ENG");
  assert.equal(await page.locator(".cloud-team-card").count(), 1);
  for (const [name, title] of [
    ["Edit team", "Edit team"],
    ["Estimate scale", "Engineering estimate scale"],
    ["Workflow", "Team workflow"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: title, exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  await page.getByText("Labels", { exact: true }).click();
  await page.getByRole("button", { name: "New label", exact: true }).waitFor();
  await page.getByText("Labels", { exact: true }).click();
  passed("Team prefix search, configuration dialogs and label disclosure");

  await appearance("dark");
  await page.goto(`${fixture.origin}/cloud/cycles/${data.cycle.id}`);
  await page.getByRole("button", { name: "Start cycle", exact: true }).click();
  await saveDialog("Start cycle");
  await page
    .getByRole("button", { name: "Complete cycle", exact: true })
    .waitFor();
  assert.equal(
    (await api(`cycles/${data.cycle.id}`)).committedTotals.points,
    64,
  );
  await page.goto(`${fixture.origin}/cloud/cycles`);
  assert.equal(
    await page
      .getByRole("region", { name: "active cycles" })
      .locator("article")
      .count(),
    1,
  );
  await page.getByLabel("Search cycles").fill("November");
  assert.equal(await page.locator(".cloud-cycle-entry").count(), 1);
  await page.getByLabel("Search cycles").fill("");
  await capture("cycles-active-dark");
  const nextCycle = (await api("workspace")).cycles.find(
    (cycle) => cycle.id !== data.cycle.id,
  );
  await page.goto(`${fixture.origin}/cloud/cycles/${data.cycle.id}`);
  await page
    .getByRole("button", { name: "Complete cycle", exact: true })
    .click();
  await page.getByLabel("Move unfinished issues to").selectOption(nextCycle.id);
  await saveDialog("Complete cycle");
  await page.locator('.cloud-cycle-context [data-status="closed"]').waitFor();
  assert.equal(
    (await api(`cycles/${data.cycle.id}`)).carriedIssueIds.length,
    9,
  );
  assert.equal((await api(`cycles/${nextCycle.id}`)).issues.length, 9);
  assert.equal(
    await page.getByText("Carried over", { exact: true }).count(),
    9,
  );
  await page
    .getByText("Original commitment · 12 issues", { exact: true })
    .click();
  assert.equal(await page.locator(".cloud-cycle-commitment li").count(), 12);
  await capture("cycle-closed-dark");
  passed(
    "Cycle search, active grouping, frozen commitment and completed-cycle carryover",
  );

  const memberContext = await fixture.createContext();
  const invite = await createPasswordInvitation(fixture, fixture.ownerContext, {
    email: "member@example.test",
    role: "member",
  });
  await acceptPasswordInvitation(fixture, memberContext, invite.url, {
    name: "Jordan Rivera",
    password: fixture.password,
  });
  await cloudApi(fixture, memberContext, "auth/login", "POST", {
    email: "member@example.test",
    password: fixture.password,
  });
  const member = await memberContext.newPage();
  await openPoker(data.issues[0].id);
  await page.getByRole("button", { name: "Start poker", exact: true }).click();
  await page.getByRole("button", { name: "Vote 5", exact: true }).click();
  await page
    .locator('button[aria-label="Vote 5"][aria-pressed="true"]')
    .waitFor();
  await member.goto(`${fixture.origin}/cloud/issues/${data.issues[0].id}`);
  await member
    .getByRole("tab", { name: "Planning poker", exact: true })
    .click();
  await member.getByRole("button", { name: "Vote 8", exact: true }).click();
  await page
    .getByRole("list", { name: "Votes", exact: true })
    .getByText("Jordan Rivera", { exact: true })
    .waitFor();
  await page
    .getByRole("list", { name: "Votes", exact: true })
    .getByText("Vote hidden", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("region", { name: "Vote distribution" }).count(),
    0,
  );
  for (const mode of modes) {
    await appearance(mode);
    await openPoker(data.issues[0].id);
    await page.getByRole("group", { name: "Estimate cards" }).waitFor();
    await capture(`poker-voting-${mode}`, page.locator(".cloud-poker"));
  }
  await page.getByRole("button", { name: "Reveal votes", exact: true }).click();
  await page.getByRole("region", { name: "Vote distribution" }).waitFor();
  assert.equal(
    await page
      .getByRole("region", { name: "Vote distribution" })
      .getByRole("listitem")
      .count(),
    2,
  );
  for (const mode of modes) {
    await appearance(mode);
    await openPoker(data.issues[0].id);
    await page.getByRole("region", { name: "Vote distribution" }).waitFor();
    await capture(`poker-revealed-${mode}`, page.locator(".cloud-poker"));
  }
  await page.getByLabel("Agreed estimate").selectOption("8");
  await page
    .getByLabel("Rationale", { exact: true })
    .fill("Include recovery and reconnect coverage.");
  await page
    .getByRole("button", { name: "Record estimate", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "Estimate:" }).waitFor();
  assert.equal((await api(`issues/${data.issues[0].id}`)).estimate, "8");
  await capture("poker-decided-mobile-light", page.locator(".cloud-poker"));
  await page.getByRole("button", { name: "Start poker", exact: true }).click();
  await page.getByRole("button", { name: "Vote 3", exact: true }).click();
  await page
    .locator('button[aria-label="Vote 3"][aria-pressed="true"]')
    .waitFor();
  await page
    .getByRole("button", { name: "Restart round", exact: true })
    .click();
  await page.getByText("No votes yet.", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.cloud-poker-cards button[aria-pressed="true"]')
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Close round", exact: true }).click();
  await page.getByText("Round closed", { exact: true }).waitFor();
  passed(
    "Two-user hidden votes, revealed distribution, persisted estimate, restart and close",
  );

  const emptyCycle = await api("cycles", "POST", {
    teamId: data.team.id,
    name: "Unplanned capacity",
    startsOn: "2026-12-01",
    endsOn: "2026-12-15",
    timezone: "UTC",
    capacity: 0,
  });
  await page.goto(`${fixture.origin}/cloud/cycles/${emptyCycle.id}`);
  await page.getByText("No issues in this cycle.", { exact: true }).waitFor();
  await page.getByText("0 points available", { exact: true }).waitFor();
  await capture("cycle-empty-mobile-light");
  passed("Empty cycle with zero capacity renders without invalid progress");
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      { captures, checks, accessibility, pageErrors: fixture.pageErrors },
      null,
      2,
    ),
  );
  assert.deepEqual(
    accessibility,
    [],
    "Accessibility findings; see results.json",
  );
  process.stdout.write(
    `Verified ${captures.length} views and ${checks.length} interactions.\n`,
  );
} catch (error) {
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      {
        message: error.message,
        url: page.url(),
        captures,
        checks,
        accessibility,
        pageErrors: fixture.pageErrors,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await fixture.close();
}
